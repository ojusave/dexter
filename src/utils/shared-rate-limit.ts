/**
 * Shared Redis-based rate limit counters for cross-service LLM rate limiting.
 *
 * Both stock-analyzer and Dexter share API keys. This module uses Redis
 * counters so both services see the same usage totals and avoid exceeding
 * shared rate limits (e.g., Groq 30 RPM across both services).
 *
 * Key pattern matches stock-analyzer's:
 *   llm:rpm:{category}:{minute_bucket}
 *   llm:rpd:{category}:{day_bucket}
 */
import { logger } from '@/utils';

// Lazy Redis connection — only created when REDIS_URL is set
let redisClient: ReturnType<typeof createRedisClient> | null = null;
let redisUnavailable = false;

interface SimpleRedis {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<number>;
  decr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  quit(): Promise<void>;
}

function createRedisClient(): SimpleRedis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  // Use Bun's native TCP for a minimal Redis client
  // We only need EVAL, DECR, GET — no need for a full library
  let connected = false;
  let socket: ReturnType<typeof Bun.connect> | null = null;
  let responseQueue: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }> = [];
  let buffer = '';

  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname;
  const port = parseInt(parsedUrl.port || '6379');
  const password = parsedUrl.password || undefined;

  async function ensureConnected() {
    if (connected && socket) return;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Redis connect timeout')), 3000);
      socket = Bun.connect({
        hostname: host,
        port,
        socket: {
          open(sock) {
            connected = true;
            clearTimeout(timeout);
            if (password) {
              sock.write(`AUTH ${password}\r\n`);
            }
            resolve();
          },
          data(_sock, data) {
            buffer += new TextDecoder().decode(data);
            processBuffer();
          },
          close() {
            connected = false;
            socket = null;
            // Reject any pending
            for (const p of responseQueue) {
              p.reject(new Error('Redis connection closed'));
            }
            responseQueue = [];
          },
          error(_sock, err) {
            connected = false;
            clearTimeout(timeout);
            reject(err);
          },
        },
      }) as any;
    });
  }

  function processBuffer() {
    while (buffer.length > 0 && responseQueue.length > 0) {
      const newlineIdx = buffer.indexOf('\r\n');
      if (newlineIdx === -1) break;

      const line = buffer.substring(0, newlineIdx);
      buffer = buffer.substring(newlineIdx + 2);

      const prefix = line[0];
      const value = line.substring(1);

      if (prefix === ':') {
        // Integer reply
        responseQueue.shift()?.resolve(parseInt(value));
      } else if (prefix === '+') {
        // Simple string (e.g., OK from AUTH)
        if (value === 'OK' && responseQueue.length > 0) {
          responseQueue.shift()?.resolve(value);
        }
      } else if (prefix === '-') {
        // Error
        responseQueue.shift()?.reject(new Error(value));
      } else if (prefix === '$') {
        // Bulk string
        const len = parseInt(value);
        if (len === -1) {
          responseQueue.shift()?.resolve(null);
        } else {
          // Need to read len + 2 more bytes (data + \r\n)
          if (buffer.length >= len + 2) {
            const data = buffer.substring(0, len);
            buffer = buffer.substring(len + 2);
            responseQueue.shift()?.resolve(data);
          } else {
            // Put line back and wait for more data
            buffer = line + '\r\n' + buffer;
            break;
          }
        }
      }
    }
  }

  async function sendCommand(...args: (string | number)[]): Promise<any> {
    await ensureConnected();
    if (!socket) throw new Error('No Redis connection');

    const parts = args.map(String);
    // RESP protocol
    let cmd = `*${parts.length}\r\n`;
    for (const part of parts) {
      cmd += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
    }

    return new Promise((resolve, reject) => {
      responseQueue.push({ resolve, reject });
      (socket as any).write(cmd);
    });
  }

  return {
    async eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<number> {
      return sendCommand('EVAL', script, numkeys, ...args);
    },
    async decr(key: string): Promise<number> {
      return sendCommand('DECR', key);
    },
    async get(key: string): Promise<string | null> {
      return sendCommand('GET', key);
    },
    async quit(): Promise<void> {
      if (socket) {
        try { await sendCommand('QUIT'); } catch {}
        connected = false;
        socket = null;
      }
    },
  };
}

function getRedis(): SimpleRedis | null {
  if (redisUnavailable) return null;
  if (!redisClient) {
    redisClient = createRedisClient();
    if (!redisClient) {
      redisUnavailable = true;
      logger.info('[SharedRateLimit] REDIS_URL not set, shared rate limiting disabled');
    }
  }
  return redisClient;
}

const LUA_INCR = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

function minuteBucket(): number {
  return Math.floor(Date.now() / 60000);
}

function dayBucket(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// Provider category mapping — must match stock-analyzer's _get_rate_limit_category()
const PROVIDER_RPM: Record<string, { category: string; rpm: number; rpd: number }> = {
  groq: { category: 'groq', rpm: 30, rpd: 1000 },
  cerebras: { category: 'cerebras', rpm: 30, rpd: 14400 },
  nvidia: { category: 'nvidia', rpm: 40, rpd: 5000 },
  sambanova: { category: 'sambanova', rpm: 30, rpd: 10000 },
  google: { category: 'google', rpm: 5, rpd: 20 },
  mistral: { category: 'mistral', rpm: 2, rpd: 200 },
  openrouter: { category: 'openrouter_free', rpm: 20, rpd: 200 },
  deepseek: { category: 'deepseek', rpm: 60, rpd: 10000 },
  openai: { category: 'openai', rpm: 60, rpd: 10000 },
  anthropic: { category: 'openai', rpm: 60, rpd: 10000 }, // no shared limit tracked
};

// Per-model categories for providers with independent rate limit buckets
const MODEL_CATEGORIES: Record<string, { category: string; rpm: number; rpd: number }> = {
  // Groq: each model has independent rate limits!
  'llama-3.3-70b-versatile': { category: 'groq_llama33_70b', rpm: 30, rpd: 1000 },
  'meta-llama/llama-4-scout-17b': { category: 'groq_llama4_scout', rpm: 30, rpd: 1000 },
  'meta-llama/llama-4-maverick-17b': { category: 'groq_llama4_maverick', rpm: 30, rpd: 1000 },
  'qwen/qwen3-32b': { category: 'groq_qwen3_32b', rpm: 60, rpd: 1000 },
  'moonshotai/kimi-k2-instruct': { category: 'groq_kimi_k2', rpm: 60, rpd: 1000 },
  'openai/gpt-oss-120b': { category: 'groq_gpt_oss_120b', rpm: 30, rpd: 1000 },
  'llama-3.1-8b-instant': { category: 'groq_llama31_8b', rpm: 30, rpd: 14400 },
  // Google: per-model categories
  'gemini-2.5-flash-lite': { category: 'google_flash_lite_25', rpm: 10, rpd: 20 },
  'gemini-2.5-flash': { category: 'google_flash_25', rpm: 5, rpd: 20 },
  'gemini-3-flash-preview': { category: 'google_flash_3', rpm: 5, rpd: 20 },
};

function getCategoryForModel(providerId: string, modelName: string): { category: string; rpm: number; rpd: number } | null {
  // Check per-model categories first (Groq, Google have independent buckets)
  if (MODEL_CATEGORIES[modelName]) {
    return MODEL_CATEGORIES[modelName];
  }
  return PROVIDER_RPM[providerId] || null;
}

/**
 * Check shared Redis rate limit before making an LLM call.
 * Returns true if the request is allowed, false if rate limited.
 * Fail-open: returns true on any Redis error.
 */
export async function checkSharedRateLimit(providerId: string, modelName: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // No Redis = fail open

  const limits = getCategoryForModel(providerId, modelName);
  if (!limits) return true;

  try {
    const minuteKey = `llm:rpm:${limits.category}:${minuteBucket()}`;
    const currentRpm = await redis.eval(LUA_INCR, 1, minuteKey, 120);

    if (currentRpm > limits.rpm) {
      await redis.decr(minuteKey);
      logger.warn(`[SharedRateLimit] RPM limit (${limits.rpm}) reached for ${limits.category} (${currentRpm - 1} used)`);
      return false;
    }

    const dayKey = `llm:rpd:${limits.category}:${dayBucket()}`;
    const currentRpd = await redis.eval(LUA_INCR, 1, dayKey, 90000);

    if (currentRpd > limits.rpd) {
      await redis.decr(dayKey);
      await redis.decr(minuteKey);
      logger.warn(`[SharedRateLimit] RPD limit (${limits.rpd}) reached for ${limits.category} (${currentRpd - 1} used)`);
      return false;
    }

    return true;
  } catch (e) {
    logger.debug(`[SharedRateLimit] Redis error (fail-open): ${e}`);
    return true;
  }
}

/**
 * Get current shared usage for a provider (for monitoring).
 */
export async function getSharedUsage(providerId: string, modelName: string): Promise<{ rpm_used: number | null; rpd_used: number | null }> {
  const redis = getRedis();
  if (!redis) return { rpm_used: null, rpd_used: null };

  const limits = getCategoryForModel(providerId, modelName);
  if (!limits) return { rpm_used: null, rpd_used: null };

  try {
    const minuteKey = `llm:rpm:${limits.category}:${minuteBucket()}`;
    const dayKey = `llm:rpd:${limits.category}:${dayBucket()}`;
    const rpm = await redis.get(minuteKey);
    const rpd = await redis.get(dayKey);
    return { rpm_used: rpm ? parseInt(rpm) : 0, rpd_used: rpd ? parseInt(rpd) : 0 };
  } catch {
    return { rpm_used: null, rpd_used: null };
  }
}
