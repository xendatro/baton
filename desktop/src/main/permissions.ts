import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/**
 * Approvals through the app (BAT-24). Headless sessions can't show permission prompts, so for
 * Claude Code the app hosts this small local MCP server and passes its `approve` tool as
 * `--permission-prompt-tool`: whatever Claude would ask shows as an Allow / Deny pop-up. It
 * listens on 127.0.0.1 only, behind a random token, one URL per job (so the HUD knows which job
 * is blocked).
 */

export interface PermissionRequest {
  jobId: string;
  tool: string;
  input: Record<string, unknown>;
}

export type Ask = (request: PermissionRequest) => Promise<boolean>;

/** A short human description of a tool call: the command, the file, or the tool's name. */
export function describeToolCall(tool: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command : null;
  if (command) return `run \`${command.length > 200 ? `${command.slice(0, 200)}…` : command}\``;
  const file =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null;
  if (file) return `${tool === 'Read' ? 'read' : 'change'} ${file}`;
  const url = typeof input.url === 'string' ? input.url : null;
  if (url) return `open ${url}`;
  return `use ${tool}`;
}

export class PermissionServer {
  readonly token = randomBytes(24).toString('hex');
  private server: http.Server | null = null;
  private port = 0;

  constructor(private readonly ask: Ask) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  urlFor(jobId: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(jobId)}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const match = /^\/mcp\/([^/?]+)/.exec(req.url ?? '');
    if (!match?.[1] || req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(404).end();
      return;
    }
    const jobId = decodeURIComponent(match[1]);
    const server = new McpServer({ name: 'baton_desktop', version: '0.1.0' });
    server.registerTool(
      'approve',
      {
        description:
          'Asks the person at this machine to allow or deny a tool call (Baton desktop app).',
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()).default({}),
          tool_use_id: z.string().optional(),
        },
      },
      async ({ tool_name, input }) => {
        const allowed = await this.ask({ jobId, tool: tool_name, input });
        const decision = allowed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The person at this machine denied it in the Baton app.' };
        return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}
