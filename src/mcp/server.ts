import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from '../log.ts';
import { z, type ZodRawShape } from 'zod';
import { strictArgs } from './args.ts';
import { registerMarkReadTool } from './mark-read.ts';
import { registerEmojiTools } from './tools-emoji.ts';
import { registerReadTools } from './tools-read.ts';
import { registerSavePinTools } from './tools-save-pin.ts';
import { registerScheduleTools } from './tools-schedule.ts';
import { registerSendTools } from './tools-send.ts';
import { registerStatusTools } from './tools-status.ts';
import { registerThreadTools } from './tools-threads.ts';
import type { ToolContext } from './tool.ts';

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'mcp-server-for-mattermost', version: '0.1.0' });
  // Wrapped here rather than in each tool file: every tool registered with a plain shape gets the strict check without each lane writing it. A tool that passes its own zod schema must make it strict itself.
  // Not touching a tool without inputSchema: the SDK then calls its handler without arguments, and a shape would change that call.
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: { inputSchema?: object }, cb: unknown) =>
    register(name, { ...config, inputSchema: config.inputSchema && !(config.inputSchema instanceof z.core.$ZodType) ? strictArgs(config.inputSchema as ZodRawShape) : config.inputSchema } as never, cb as never)) as typeof server.registerTool;
  // Not logged by guarded: the SDK checks the arguments before it calls the tool. Wrapping a private method of the pinned SDK; the unit test fails if it goes away.
  const validate = server['validateToolInput'] as ((tool: unknown, args: unknown, toolName: string) => Promise<unknown>) | undefined;
  if (validate) {
    server['validateToolInput'] = (async (tool: unknown, args: unknown, toolName: string) => {
      const started = Date.now();
      try {
        return await validate.call(server, tool, args, toolName);
      } catch (e) {
        log('tool_call', { mm_user_id: ctx.mmUserId, tool: toolName, outcome: 'invalid_args', ms: Date.now() - started });
        throw e;
      }
    }) as never;
  }
  registerReadTools(server, ctx);
  registerSendTools(server, ctx);
  registerScheduleTools(server, ctx);
  registerMarkReadTool(server, ctx);
  registerSavePinTools(server, ctx);
  registerStatusTools(server, ctx);
  registerEmojiTools(server, ctx);
  registerThreadTools(server, ctx);
  return server;
}
