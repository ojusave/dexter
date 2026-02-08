/**
 * HTTP API server for Dexter.
 * Wraps the Agent in a simple REST API so other services can call it.
 */
import { config } from 'dotenv';
import { Agent } from './agent/agent.js';

config({ quiet: true });

const PORT = parseInt(process.env.PORT || '3100', 10);

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
      return Response.json({ status: 'ok' }, { headers: corsHeaders });
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

        const agent = Agent.create({
          model: body.model || process.env.DEXTER_MODEL || 'gpt-5.2',
          maxIterations: body.maxIterations || 10,
        });

        let answer = '';
        const toolCalls: Array<{ tool: string; args: Record<string, unknown>; duration?: number }> = [];
        let iterations = 0;
        let totalTime = 0;

        for await (const event of agent.run(body.query)) {
          if (event.type === 'tool_end') {
            toolCalls.push({ tool: event.tool, args: event.args, duration: event.duration });
          }
          if (event.type === 'done') {
            answer = event.answer;
            iterations = event.iterations;
            totalTime = event.totalTime;
          }
        }

        return Response.json(
          { answer, toolCalls, iterations, totalTime },
          { headers: corsHeaders }
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

console.log(`Dexter API running on port ${server.port}`);
