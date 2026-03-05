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
    
    if (configuredProviders.length === 0) {
      throw new Error('No search providers configured. Set EXASEARCH_API_KEY, PERPLEXITY_API_KEY, or TAVILY_API_KEY.');
    }

    const errors: string[] = [];

    for (const provider of configuredProviders) {
      try {
        logger.info(`[web_search] Trying ${provider.name}...`);
        const result = await provider.tool.invoke({ query: input.query });
        logger.info(`[web_search] ${provider.name} succeeded`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[web_search] ${provider.name} failed: ${message}`);
        errors.push(`${provider.name}: ${message}`);
        
        // Check if it's a rate limit / credits error - try next provider
        const isRateLimitError = 
          message.includes('rate limit') ||
          message.includes('credits') ||
          message.includes('quota') ||
          message.includes('exceeded') ||
          message.includes('429') ||
          message.includes('402');
        
        if (!isRateLimitError) {
          // For non-rate-limit errors, still try next provider but log differently
          logger.warn(`[web_search] Non-rate-limit error from ${provider.name}, trying next provider`);
        }
      }
    }

    // All providers failed
    throw new Error(`All search providers failed: ${errors.join(' | ')}`);
  },
});
