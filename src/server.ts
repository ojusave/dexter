/**
 * HTTP API server for Dexter.
 * Wraps the Agent in a simple REST API so other services can call it.
 * Supports model fallback chain via DEXTER_FALLBACK_MODELS env var.
 * 
 * Automatic fallback: When a provider hits billing/quota limits, the LLM layer
 * automatically falls back to other configured providers. Providers in cooldown
 * are skipped for 5 minutes before being retried.
 */
import { config } from 'dotenv';
import { Agent } from './agent/agent.js';
import { getProviderStatus, clearProviderCooldown } from './model/llm.js';

config({ quiet: true });

const PORT = parseInt(process.env.PORT || '3100', 10);

/** Build ordered list of models: primary + fallbacks */
function getModelChain(requestModel?: string): string[] {
  const primary = requestModel || process.env.DEXTER_MODEL || 'openrouter:meta-llama/llama-3.3-70b-instruct:free';
  const fallbacks = (process.env.DEXTER_FALLBACK_MODELS || '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
  // Deduplicate: don't retry the same model
  const chain = [primary];
  for (const fb of fallbacks) {
    if (!chain.includes(fb)) chain.push(fb);
  }
  return chain;
}

/** Run agent with a single model, returns result or throws */
async function runAgent(
  query: string,
  model: string
): Promise<{
  answer: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; duration?: number }>;
  iterations: number;
  totalTime: number;
}> {
  const agent = await Agent.create({ model });

  let answer = '';
  const toolCalls: Array<{ tool: string; args: Record<string, unknown>; duration?: number }> = [];
  let iterations = 0;
  let totalTime = 0;

  for await (const event of agent.run(query)) {
    if (event.type === 'tool_end') {
      toolCalls.push({ tool: event.tool, args: event.args, duration: event.duration });
    }
    if (event.type === 'done') {
      answer = event.answer;
      iterations = event.iterations;
      totalTime = event.totalTime;
    }
  }

  return { answer, toolCalls, iterations, totalTime };
}

const server = Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const models = getModelChain();
      const providers = getProviderStatus();
      const availableProviders = providers.filter(p => p.available);
      
      return Response.json(
        { 
          status: availableProviders.length > 0 ? 'ok' : 'degraded',
          primaryModel: models[0], 
          fallbackModels: models.slice(1),
          providers,
          availableCount: availableProviders.length,
          totalCount: providers.length,
        },
        { headers: corsHeaders }
      );
    }

    // Provider status endpoint (detailed)
    if (url.pathname === '/api/providers' && req.method === 'GET') {
      const providers = getProviderStatus();
      return Response.json({ providers }, { headers: corsHeaders });
    }

    // Reset provider cooldowns (admin endpoint)
    if (url.pathname === '/api/providers/reset' && req.method === 'POST') {
      try {
        const body = await req.json() as { providerId?: string };
        clearProviderCooldown(body.providerId);
        return Response.json(
          { 
            success: true, 
            message: body.providerId 
              ? `Cleared cooldown for ${body.providerId}` 
              : 'Cleared all provider cooldowns',
            providers: getProviderStatus(),
          },
          { headers: corsHeaders }
        );
      } catch {
        clearProviderCooldown();
        return Response.json(
          { success: true, message: 'Cleared all provider cooldowns', providers: getProviderStatus() },
          { headers: corsHeaders }
        );
      }
    }

    // Research endpoint
    if (url.pathname === '/api/research' && req.method === 'POST') {
      try {
        const body = await req.json() as { query?: string; model?: string };

        if (!body.query) {
          return Response.json(
            { error: 'Missing required field: query' },
            { status: 400, headers: corsHeaders }
          );
        }

        const models = getModelChain(body.model);
        const errors: string[] = [];

        for (const model of models) {
          try {
            console.log(`[research] trying model: ${model}`);
            const result = await runAgent(body.query, model);
            return Response.json(
              { ...result, model },
              { headers: corsHeaders }
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[research] model ${model} failed: ${msg}`);
            errors.push(`${model}: ${msg}`);
          }
        }

        // All models failed
        return Response.json(
          { error: `All models failed. ${errors.join(' | ')}` },
          { status: 500, headers: corsHeaders }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: corsHeaders }
    );
  },
});

const models = getModelChain();
console.log(`Dexter API running on port ${server.port}`);
console.log(`  Primary model: ${models[0]}`);
if (models.length > 1) {
  console.log(`  Fallback models: ${models.slice(1).join(' → ')}`)
}
