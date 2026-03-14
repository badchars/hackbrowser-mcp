/**
 * MCP Server — exposes HackBrowser tools via Model Context Protocol.
 * Supports stdio and streamable HTTP transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { allTools, type ToolContext, type ToolResult } from "./tools.js";

/**
 * Create and configure the MCP server with all tools.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "hackbrowser-mcp",
    version: "0.1.0",
  });

  // Register all tools
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args: any) => {
        try {
          const result = await tool.execute(args, ctx);
          return result as any;
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${(err as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

/**
 * Start MCP server with stdio transport.
 */
export async function startMcpStdio(ctx: ToolContext): Promise<McpServer> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Server started (stdio transport)");
  return server;
}
