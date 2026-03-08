/**
 * Fallback web search that tries multiple providers in order.
 * Exa → Perplexity → Tavily
 * 
 * If one provider fails (rate limit, credits exhausted, etc.),
 * automatically tries the next one.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { exaSearch } from './exa.js';
import { perplexitySearch } from './perplexity.js';
import { tavilySearch } from './tavily.js';
import { logger } from '../../utils/logger.js';
import { checkSearchRateLimit } from '../../utils/shared-rate-limit.js';

// Map provider names to rate limit keys (only for providers with strict limits)
const RATE_LIMITED_PROVIDERS: Record<string, string> = {
  'Tavily': 'tavily', // 1000/month free tier
};

interface SearchProvider {
  name: string;
  tool: DynamicStructuredTool;
  isConfigured: () => boolean;
}

const PROVIDERS: SearchProvider[] = [
  {
    name: 'Exa',
    tool: exaSearch,
    isConfigured: () => !!process.env.EXASEARCH_API_KEY,
  },
  {
    name: 'Perplexity',
    tool: perplexitySearch,
    isConfigured: () => !!process.env.PERPLEXITY_API_KEY,
  },
  {
    name: 'Tavily',
    tool: tavilySearch,
    isConfigured: () => !!process.env.TAVILY_API_KEY,
  },
];

export const fallbackSearch = new DynamicStructuredTool({
  name: 'web_search',
  description: 'Search the web for current information. Automatically falls back between providers if one fails.',
  schema: z.object({
    query: z.string().describe('The search query'),
  }),
  func: async (input) => {
    const configuredProviders = PROVIDERS.filter(p => p.isConfigured());
    
    // Log which providers are configured
    console.log(`[web_search] Query: "${input.query.slice(0, 50)}..."`);
    console.log(`[web_search] Configured providers: ${configuredProviders.map(p => p.name).join(', ')}`);
    console.log(`[web_search] EXASEARCH_API_KEY set: ${!!process.env.EXASEARCH_API_KEY}`);
    console.log(`[web_search] PERPLEXITY_API_KEY set: ${!!process.env.PERPLEXITY_API_KEY}`);
    console.log(`[web_search] TAVILY_API_KEY set: ${!!process.env.TAVILY_API_KEY}`);
    
    if (configuredProviders.length === 0) {
      throw new Error('No search providers configured. Set EXASEARCH_API_KEY, PERPLEXITY_API_KEY, or TAVILY_API_KEY.');
    }

    const errors: string[] = [];

    for (const provider of configuredProviders) {
      // Check rate limit for providers with strict quotas (e.g. Tavily 1000/month)
      const rateLimitKey = RATE_LIMITED_PROVIDERS[provider.name];
      if (rateLimitKey) {
        const allowed = await checkSearchRateLimit(rateLimitKey);
        if (!allowed) {
          console.log(`[web_search] ${provider.name} skipped: daily rate limit reached (preserving monthly quota)`);
          errors.push(`${provider.name}: daily rate limit reached`);
          continue;
        }
      }

      try {
        console.log(`[web_search] Trying ${provider.name}...`);
        const result = await provider.tool.invoke({ query: input.query });
        console.log(`[web_search] ${provider.name} succeeded!`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[web_search] ${provider.name} FAILED: ${message}`);
        errors.push(`${provider.name}: ${message}`);
      }
    }

    // All providers failed
    throw new Error(`All search providers failed: ${errors.join(' | ')}`);
  },
});
