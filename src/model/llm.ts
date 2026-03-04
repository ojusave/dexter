import { AIMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import { DEFAULT_SYSTEM_PROMPT } from '@/agent/prompts';
import type { TokenUsage } from '@/agent/types';
import { logger } from '@/utils';
import { classifyError, isNonRetryableError, isBillingError, isRateLimitError } from '@/utils/errors';
import { resolveProvider, getProviderById, PROVIDERS } from '@/providers';

export const DEFAULT_PROVIDER = 'groq';
export const DEFAULT_MODEL = 'groq:llama-3.3-70b-versatile';

/**
 * Fallback chain for when primary provider has billing/quota issues.
 * Order: FREE tier (Groq, Cerebras, Nvidia, SambaNova) → CHEAP paid → EXPENSIVE (last resort)
 */
function getAvailableFallbackModels(): string[] {
  const fallbacks: string[] = [];
  
  // Priority order: FREE TIER (fast providers) → CHEAP PAID → EXPENSIVE
  const fallbackOrder = [
    // FREE tier providers with generous limits (fastest, most reliable)
    { envVar: 'GROQ_API_KEY', model: 'groq:llama-3.3-70b-versatile' },
    { envVar: 'CEREBRAS_API_KEY', model: 'cerebras:llama-3.3-70b' },
    { envVar: 'NVIDIA_API_KEY', model: 'nvidia:meta/llama-3.1-70b-instruct' },
    { envVar: 'SAMBANOVA_API_KEY', model: 'sambanova:Meta-Llama-3.3-70B-Instruct' },
    // CHEAP paid models (fallback)
    { envVar: 'GOOGLE_API_KEY', model: 'gemini-2.5-flash-preview-05-20' },
    { envVar: 'MISTRAL_API_KEY', model: 'mistral-small-latest' },
    { envVar: 'OPENROUTER_API_KEY', model: 'openrouter:openrouter/auto' },
    // EXPENSIVE models (last resort)
    { envVar: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-20250514' },
    { envVar: 'OPENAI_API_KEY', model: 'gpt-5-mini' },
  ];
  
  const seen = new Set<string>();
  for (const { envVar, model } of fallbackOrder) {
    if (process.env[envVar] && !seen.has(model)) {
      fallbacks.push(model);
      seen.add(model);
    }
  }
  
  return fallbacks;
}

// Track which providers have had billing errors (circuit breaker)
const providerBillingErrors: Map<string, number> = new Map();
const BILLING_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function markProviderBillingError(providerId: string): void {
  providerBillingErrors.set(providerId, Date.now());
  logger.warn(`[LLM] Provider ${providerId} marked as having billing issues, will use fallback`);
}

function isProviderInCooldown(providerId: string): boolean {
  const errorTime = providerBillingErrors.get(providerId);
  if (!errorTime) return false;
  
  const elapsed = Date.now() - errorTime;
  if (elapsed > BILLING_ERROR_COOLDOWN_MS) {
    providerBillingErrors.delete(providerId);
    logger.info(`[LLM] Provider ${providerId} cooldown expired, will retry`);
    return false;
  }
  return true;
}

/**
 * Get the current status of all providers for health monitoring.
 */
export function getProviderStatus(): Array<{
  id: string;
  name: string;
  available: boolean;
  hasApiKey: boolean;
  inCooldown: boolean;
  cooldownRemainingMs?: number;
}> {
  return PROVIDERS.map(provider => {
    const hasApiKey = provider.apiKeyEnvVar ? !!process.env[provider.apiKeyEnvVar] : true;
    const errorTime = providerBillingErrors.get(provider.id);
    const inCooldown = isProviderInCooldown(provider.id);
    const cooldownRemainingMs = errorTime && inCooldown 
      ? BILLING_ERROR_COOLDOWN_MS - (Date.now() - errorTime)
      : undefined;
    
    return {
      id: provider.id,
      name: provider.displayName,
      available: hasApiKey && !inCooldown,
      hasApiKey,
      inCooldown,
      cooldownRemainingMs,
    };
  });
}

/**
 * Manually clear cooldown for a provider (useful for admin reset).
 */
export function clearProviderCooldown(providerId?: string): void {
  if (providerId) {
    providerBillingErrors.delete(providerId);
    logger.info(`[LLM] Cleared cooldown for provider ${providerId}`);
  } else {
    providerBillingErrors.clear();
    logger.info(`[LLM] Cleared all provider cooldowns`);
  }
}

/**
 * Gets the fast model variant for the given provider.
 * Falls back to the provided model if no fast variant is configured (e.g., Ollama).
 */
export function getFastModel(modelProvider: string, fallbackModel: string): string {
  return getProviderById(modelProvider)?.fastModel ?? fallbackModel;
}

// Generic retry helper with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, provider: string, maxAttempts = 3): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errorType = classifyError(message);
      logger.error(`[${provider} API] ${errorType} error (attempt ${attempt + 1}/${maxAttempts}): ${message}`);

      // Mark billing errors for circuit breaker
      if (isBillingError(message) || isRateLimitError(message)) {
        const providerDef = PROVIDERS.find(p => p.displayName === provider);
        if (providerDef) {
          markProviderBillingError(providerDef.id);
        }
      }

      if (isNonRetryableError(message)) {
        throw new Error(`[${provider} API] ${message}`);
      }

      if (attempt === maxAttempts - 1) {
        throw new Error(`[${provider} API] ${message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error('Unreachable');
}

// Model provider configuration
interface ModelOpts {
  streaming: boolean;
}

type ModelFactory = (name: string, opts: ModelOpts) => BaseChatModel;

function getApiKey(envVar: string): string {
  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new Error(`[LLM] ${envVar} not found in environment variables`);
  }
  return apiKey;
}

// Factories keyed by provider id — prefix routing is handled by resolveProvider()
const MODEL_FACTORIES: Record<string, ModelFactory> = {
  anthropic: (name, opts) =>
    new ChatAnthropic({
      model: name,
      ...opts,
      apiKey: getApiKey('ANTHROPIC_API_KEY'),
    }),
  google: (name, opts) =>
    new ChatGoogleGenerativeAI({
      model: name,
      ...opts,
      apiKey: getApiKey('GOOGLE_API_KEY'),
    }),
  xai: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('XAI_API_KEY'),
      configuration: {
        baseURL: 'https://api.x.ai/v1',
      },
    }),
  openrouter: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^openrouter:/, ''),
      ...opts,
      apiKey: getApiKey('OPENROUTER_API_KEY'),
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
      },
    }),
  moonshot: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('MOONSHOT_API_KEY'),
      configuration: {
        baseURL: 'https://api.moonshot.cn/v1',
      },
    }),
  deepseek: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('DEEPSEEK_API_KEY'),
      configuration: {
        baseURL: 'https://api.deepseek.com',
      },
    }),
  groq: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^groq:/, ''),
      ...opts,
      apiKey: getApiKey('GROQ_API_KEY'),
      configuration: {
        baseURL: 'https://api.groq.com/openai/v1',
      },
    }),
  mistral: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('MISTRAL_API_KEY'),
      configuration: {
        baseURL: 'https://api.mistral.ai/v1',
      },
    }),
  cerebras: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^cerebras:/, ''),
      ...opts,
      apiKey: getApiKey('CEREBRAS_API_KEY'),
      configuration: {
        baseURL: 'https://api.cerebras.ai/v1',
      },
    }),
  sambanova: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^sambanova:/, ''),
      ...opts,
      apiKey: getApiKey('SAMBANOVA_API_KEY'),
      configuration: {
        baseURL: 'https://api.sambanova.ai/v1',
      },
    }),
  nvidia: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^nvidia:/, ''),
      ...opts,
      apiKey: getApiKey('NVIDIA_API_KEY'),
      configuration: {
        baseURL: 'https://integrate.api.nvidia.com/v1',
      },
    }),
  ollama: (name, opts) =>
    new ChatOllama({
      model: name.replace(/^ollama:/, ''),
      ...opts,
      ...(process.env.OLLAMA_BASE_URL ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
    }),
};

const DEFAULT_FACTORY: ModelFactory = (name, opts) =>
  new ChatOpenAI({
    model: name,
    ...opts,
    apiKey: getApiKey('OPENAI_API_KEY'),
  });

export function getChatModel(
  modelName: string = DEFAULT_MODEL,
  streaming: boolean = false
): BaseChatModel {
  const opts: ModelOpts = { streaming };
  const provider = resolveProvider(modelName);
  const factory = MODEL_FACTORIES[provider.id] ?? DEFAULT_FACTORY;
  return factory(modelName, opts);
}

interface CallLlmOptions {
  model?: string;
  systemPrompt?: string;
  outputSchema?: z.ZodType<unknown>;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

export interface LlmResult {
  response: AIMessage | string;
  usage?: TokenUsage;
}

function extractUsage(result: unknown): TokenUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const msg = result as Record<string, unknown>;

  const usageMetadata = msg.usage_metadata;
  if (usageMetadata && typeof usageMetadata === 'object') {
    const u = usageMetadata as Record<string, unknown>;
    const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
    const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
    const total = typeof u.total_tokens === 'number' ? u.total_tokens : input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  const responseMetadata = msg.response_metadata;
  if (responseMetadata && typeof responseMetadata === 'object') {
    const rm = responseMetadata as Record<string, unknown>;
    if (rm.usage && typeof rm.usage === 'object') {
      const u = rm.usage as Record<string, unknown>;
      const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
      const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
      const total = typeof u.total_tokens === 'number' ? u.total_tokens : input + output;
      return { inputTokens: input, outputTokens: output, totalTokens: total };
    }
  }

  return undefined;
}

/**
 * Build messages with Anthropic cache_control on the system prompt.
 * Marks the system prompt as ephemeral so Anthropic caches the prefix,
 * reducing input token costs by ~90% on subsequent calls.
 */
function buildAnthropicMessages(systemPrompt: string, userPrompt: string) {
  return [
    new SystemMessage({
      content: [
        {
          type: 'text' as const,
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
    }),
    new HumanMessage(userPrompt),
  ];
}

/**
 * Internal function to invoke a specific model without fallback logic.
 */
async function invokeModel(
  modelName: string,
  prompt: string,
  finalSystemPrompt: string,
  outputSchema: z.ZodType<unknown> | undefined,
  tools: StructuredToolInterface[] | undefined,
  signal: AbortSignal | undefined
): Promise<{ result: unknown; provider: ReturnType<typeof resolveProvider> }> {
  const llm = getChatModel(modelName, false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runnable: Runnable<any, any> = llm;

  if (outputSchema) {
    runnable = llm.withStructuredOutput(outputSchema, { strict: false });
  } else if (tools && tools.length > 0 && llm.bindTools) {
    runnable = llm.bindTools(tools);
  }

  const invokeOpts = signal ? { signal } : undefined;
  const provider = resolveProvider(modelName);

  let result;
  if (provider.id === 'anthropic') {
    const messages = buildAnthropicMessages(finalSystemPrompt, prompt);
    result = await withRetry(() => runnable.invoke(messages, invokeOpts), provider.displayName);
  } else {
    const promptTemplate = ChatPromptTemplate.fromMessages([
      ['system', finalSystemPrompt],
      ['user', '{prompt}'],
    ]);
    const chain = promptTemplate.pipe(runnable);
    result = await withRetry(() => chain.invoke({ prompt }, invokeOpts), provider.displayName);
  }

  return { result, provider };
}

export async function callLlm(prompt: string, options: CallLlmOptions = {}): Promise<LlmResult> {
  const { model = DEFAULT_MODEL, systemPrompt, outputSchema, tools, signal } = options;
  const finalSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // Build list of models to try: primary + fallbacks
  const modelsToTry: string[] = [];
  const primaryProvider = resolveProvider(model);
  
  // Skip primary if it's in cooldown due to billing errors
  if (!isProviderInCooldown(primaryProvider.id)) {
    modelsToTry.push(model);
  } else {
    logger.info(`[LLM] Skipping ${primaryProvider.displayName} (in billing cooldown), using fallback`);
  }
  
  // Add fallbacks that aren't the same provider as primary
  const fallbacks = getAvailableFallbackModels();
  for (const fallbackModel of fallbacks) {
    const fallbackProvider = resolveProvider(fallbackModel);
    if (fallbackProvider.id !== primaryProvider.id && !isProviderInCooldown(fallbackProvider.id)) {
      modelsToTry.push(fallbackModel);
    }
  }

  if (modelsToTry.length === 0) {
    throw new Error('[LLM] No available providers - all are in billing cooldown. Please check API keys and billing.');
  }

  let lastError: Error | null = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModel = modelsToTry[i];
    const currentProvider = resolveProvider(currentModel);
    const isRetry = i > 0;

    if (isRetry) {
      logger.info(`[LLM] Falling back to ${currentProvider.displayName} (${currentModel})`);
    }

    try {
      const { result, provider } = await invokeModel(
        currentModel,
        prompt,
        finalSystemPrompt,
        outputSchema,
        tools,
        signal
      );

      const usage = extractUsage(result);

      if (isRetry) {
        logger.info(`[LLM] Fallback to ${provider.displayName} succeeded`);
      }

      // If no outputSchema and no tools, extract content from AIMessage
      // When tools are provided, return the full AIMessage to preserve tool_calls
      if (!outputSchema && !tools && result && typeof result === 'object' && 'content' in result) {
        return { response: (result as { content: string }).content, usage };
      }
      return { response: result as AIMessage, usage };

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      lastError = e instanceof Error ? e : new Error(message);

      // If it's a billing/rate limit error and we have more fallbacks, continue
      if (isBillingError(message) || isRateLimitError(message)) {
        markProviderBillingError(currentProvider.id);
        
        if (i < modelsToTry.length - 1) {
          logger.warn(`[LLM] ${currentProvider.displayName} billing/rate limit error, trying next fallback...`);
          continue;
        }
      }

      // For non-billing errors or if this is the last fallback, throw
      if (i === modelsToTry.length - 1) {
        throw lastError;
      }

      // For other errors, also try fallback
      logger.warn(`[LLM] ${currentProvider.displayName} error: ${message}, trying next fallback...`);
    }
  }

  throw lastError || new Error('[LLM] All providers failed');
}
