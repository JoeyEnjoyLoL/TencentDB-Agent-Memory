import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorConfig } from "./config.js";
import { createCursorMcpServer } from "./mcp.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

const config: CursorConfig = {
  rootDir: "/root",
  dataDir: "/data",
  gatewayUrl: "http://127.0.0.1:8420",
  captureTimeoutMs: 60_000,
  ctlPath: "/ctl",
  executablePath: "/bin/memory-tencentdb-cursor",
  transcriptsRoot: "/home/test/.cursor/projects",
};

type RequestGateway = NonNullable<
  Parameters<typeof createCursorMcpServer>[1]
>;

async function connect(request: RequestGateway) {
  const server = createCursorMcpServer(config, request);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("Cursor MCP bridge", () => {
  // Surface is strictly the two read-only L1 and L0 search tools.
  it("registers only two read-only tools", async () => {
    const client = await connect(vi.fn<RequestGateway>());

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "tdai_conversation_search",
      "tdai_memory_search",
    ]);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  // L1 args map as-is onto the existing Gateway search endpoint.
  it("maps memory search", async () => {
    const request = vi.fn<RequestGateway>().mockResolvedValue({
      status: 200,
      body: { results: "memory", total: 1, strategy: "fts" },
    });
    const client = await connect(request);

    const result = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "偏好", limit: 5, type: "preference", scene: "work" },
    });

    expect(request).toHaveBeenCalledWith("/search/memories", {
      query: "偏好",
      limit: 5,
      type: "preference",
      scene: "work",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify({ results: "memory", total: 1, strategy: "fts" }),
    }]);
  });

  // L0 evidence search keeps optional session_key.
  it("maps conversation search", async () => {
    const request = vi.fn<RequestGateway>().mockResolvedValue({
      status: 200,
      body: { results: "conversation", total: 1 },
    });
    const client = await connect(request);

    await client.callTool({
      name: "tdai_conversation_search",
      arguments: { query: "原话", session_key: "cursor:c1" },
    });

    expect(request).toHaveBeenCalledWith("/search/conversations", {
      query: "原话",
      session_key: "cursor:c1",
    });
  });

  // Non-2xx Gateway responses become a single tool error; no write/fallback behavior.
  it("returns an MCP tool error on search failure", async () => {
    const client = await connect(vi.fn<RequestGateway>().mockResolvedValue({
      status: 503,
      body: { error: "unavailable" },
    }));

    const result = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "偏好" },
    });

    expect(result.isError).toBe(true);
  });
});
