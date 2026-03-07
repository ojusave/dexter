/**
 * Canonical provider registry — single source of truth for all provider metadata.
 * When adding a new provider, add a single entry here; all other modules derive from this.
 */

export interface ProviderDef {
  /** Slug used in config/settings (e.g., 'anthropic') */
  id: string;
  /** Human-readable name (e.g., 'Anthropic') */
  displayName: string;
  /** Model name prefix used for routing (e.g., 'claude-'). Empty string for default (OpenAI). */
  modelPrefix: string;
  /** Environment variable name for API key. Omit for local providers (e.g., Ollama). */
  apiKeyEnvVar?: string;
  /** Fast model variant for lightweight tasks like summarization. */
  fastModel?: string;
  /** Whether this provider supports multiple API keys for rate limit rotation */
  supportsMultiKey?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    modelPrefix: '',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    fastModel: 'gpt-4.1',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    modelPrefix: 'claude-',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    fastModel: 'claude-haiku-4-5',
  },
  {
    id: 'google',
    displayName: 'Google',
    modelPrefix: 'gemini-',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    fastModel: 'gemini-3-flash-preview',
  },
  {
    id: 'xai',
    displayName: 'xAI',
    modelPrefix: 'grok-',
    apiKeyEnvVar: 'XAI_API_KEY',
    fastModel: 'grok-4-1-fast-reasoning',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    modelPrefix: 'kimi-',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    fastModel: 'kimi-k2-5',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    modelPrefix: 'deepseek-',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    fastModel: 'deepseek-chat',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    modelPrefix: 'groq:',
    apiKeyEnvVar: 'GROQ_API_KEY',
    fastModel: 'groq:meta-llama/llama-4-scout-17b-16e-instruct',
    supportsMultiKey: true,
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    modelPrefix: 'mistral-',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    fastModel: 'mistral-small-3-2-25-06',
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    modelPrefix: 'cerebras:',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    fastModel: 'cerebras:llama3.1-8b',
    supportsMultiKey: true,
  },
  {
    id: 'sambanova',
    displayName: 'SambaNova',
    modelPrefix: 'sambanova:',
    apiKeyEnvVar: 'SAMBANOVA_API_KEY',
    fastModel: 'sambanova:Meta-Llama-3.3-70B-Instruct',
  },
  {
    id: 'nvidia',
    displayName: 'NVIDIA NIM',
    modelPrefix: 'nvidia:',
    apiKeyEnvVar: 'NVIDIA_API_KEY',
    fastModel: 'nvidia:meta/llama-3.1-70b-instruct',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    modelPrefix: 'openrouter:',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    fastModel: 'openrouter:meta-llama/llama-3.3-70b-instruct',
    supportsMultiKey: true,
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    modelPrefix: 'ollama:',
  },
];

const defaultProvider = PROVIDERS.find((p) => p.id === 'openai')!;

/**
 * Resolve the provider for a given model name based on its prefix.
 * Falls back to OpenAI when no prefix matches.
 */
export function resolveProvider(modelName: string): ProviderDef {
  return (
    PROVIDERS.find((p) => p.modelPrefix && modelName.startsWith(p.modelPrefix)) ??
    defaultProvider
  );
}

/**
 * Look up a provider by its slug (e.g., 'anthropic', 'google').
 */
export function getProviderById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Get all API keys for a provider that supports multi-key rotation.
 * Supports: comma-separated (KEY=key1,key2) or numbered vars (KEY, KEY_2, KEY_3).
 */
export function getApiKeysForProvider(providerId: string): string[] {
  const provider = getProviderById(providerId);
  if (!provider?.apiKeyEnvVar) return [];
  
  const baseVar = provider.apiKeyEnvVar;
  const envValue = process.env[baseVar] ?? '';
  const raw = envValue.trim();
  
  if (!raw) return [];
  
  if (provider.supportsMultiKey && raw.includes(',')) {
    return raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
  }
  
  const keys: string[] = [raw];
  if (provider.supportsMultiKey) {
    for (let i = 2; i <= 5; i++) {
      const v = (process.env[`${baseVar}_${i}`] ?? '').trim();
      if (v) keys.push(v);
    }
  }
  return keys;
}

/**
 * Check if a provider has any API keys configured.
 */
export function hasApiKeyForProvider(providerId: string): boolean {
  return getApiKeysForProvider(providerId).length > 0;
}
