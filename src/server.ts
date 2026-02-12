/**
 * HTTP API server for Dexter.
 * Wraps the Agent in a simple REST API so other services can call it.
 * Supports model fallback chain via DEXTER_FALLBACK_MODELS env var.
 */
import { config } from 'dotenv';
import { Agent } from './agent/agent.js';

config({ quiet: true });

const PORT = parseInt(process.env.PORT || '3100', 10);

/** Build ordered list of models: primary + fallbacks */
function getModelChain(requestModel?: string): string[] {
  const primary = requestModel || process.env.DEXTER_MODEL || 'gpt-5.2';
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
  model: string,
  maxIterations: number
): Promise<{
  answer: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; duration?: number }>;
  iterations: number;
  totalTime: number;
}> {
  const agent = Agent.create({ model, maxIterations });

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
      return Response.json(
        { status: 'ok', primaryModel: models[0], fallbackModels: models.slice(1) },
        { headers: corsHeaders }
      );
    }

    // Research endpoint
    if (url.pathname === '/api/research' && req.method === 'POST') {
      try {
        const body = await req.json() as { query?: string; model?: string; maxIterations?: number };

        if (!body.query) {
          return Response.json(
            { error: 'Missing required field: query' },
            { status: 400, headers: corsHeaders }
          );
        }

        const models = getModelChain(body.model);
        const maxIterations = body.maxIterations || 10;
        const errors: string[] = [];

        for (const model of models) {
          try {
            console.log(`[research] trying model: ${model}`);
            const result = await runAgent(body.query, model, maxIterations);
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
