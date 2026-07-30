import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CursorConfig } from "./config.js";
import type {
  ConversationSearchRequest,
  MemorySearchRequest,
} from "../../gateway/types.js";
import { gatewayRequest, type GatewayResult } from "./gateway.js";

type RequestGateway = (
  route: string,
  body: unknown,
) => Promise<GatewayResult>;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function toolResult(result: GatewayResult) {
  if (
    result.status === undefined ||
    result.status < 200 ||
    result.status >= 300
  ) {
    return {
      isError: true as const,
      content: [{
        type: "text" as const,
        text: `Gateway search failed: ${result.status ?? "network"} ${result.error ?? ""}`.trim(),
      }],
    };
  }
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(result.body ?? null),
    }],
  };
}

export function createCursorMcpServer(
  config: CursorConfig,
  request: RequestGateway = (route, body) =>
    gatewayRequest(route, body, config),
): McpServer {
  const server = new McpServer({
    name: "tencentdb-memory-cursor",
    version: "1.0.0",
  });

  server.registerTool("tdai_memory_search", {
    description: "搜索 L1 结构化长期记忆",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      type: z.string().optional(),
      scene: z.string().optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async ({ query, limit, type, scene }) => {
    const body: MemorySearchRequest = compact({
      query,
      limit,
      type,
      scene,
    });
    return toolResult(await request("/search/memories", body));
  });

  server.registerTool("tdai_conversation_search", {
    description: "搜索 L0 对话原文与证据",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      session_key: z.string().optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async ({ query, limit, session_key }) => {
    const body: ConversationSearchRequest = compact({
      query,
      limit,
      session_key,
    });
    return toolResult(await request("/search/conversations", body));
  });

  return server;
}

export async function runCursorMcpServer(config: CursorConfig): Promise<void> {
  const server = createCursorMcpServer(config);
  await server.connect(new StdioServerTransport());
}
