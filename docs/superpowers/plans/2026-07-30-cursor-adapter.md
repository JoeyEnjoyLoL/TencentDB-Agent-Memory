# Cursor Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `docs/316base/prd.md` 定义的 Cursor 本地 Adapter，并保留真实 Cursor Hook spike 作为发布门禁。

**Architecture:** 单个 `memory-tencentdb-cursor` CLI 承载 Hook、detached one-shot、stdio MCP、安装和 spike 子命令。Hook 只追加每轮 JSONL 或读取 L3/L2；one-shot 在 `proper-lockfile` 全局锁内启动 Gateway、串行投递并清理；安装器只合并 Adapter 自己的配置。

**Tech Stack:** TypeScript、Node.js 22、Vitest、`proper-lockfile@4.1.2`、`@modelcontextprotocol/sdk@1.30.0`

## Global Constraints

- v1 只支持 Linux、macOS 的 Cursor 本地 IDE。
- 不修改 Gateway、TdaiCore、L0 和现有 MCP server。
- 前台 Hook 不执行网络、Gateway 启动、健康检查和 pending 全量扫描。
- capture 只发送 `user_content`、`assistant_content`、`session_key`。
- 所有新增关键测试使用中文简述注释，标点使用英文。
- 真实 Cursor spike 未形成证据前，不宣称发布验收完成。

---

### Task 1: CLI 与运行配置

**Files:**
- Create: `cursor.ts`
- Create: `bin/memory-tencentdb-cursor.mjs`
- Create: `src/adapters/cursor/config.ts`
- Create: `src/adapters/cursor/cli.ts`
- Create: `src/adapters/cursor/config.test.ts`
- Modify: `package.json`
- Modify: `tsdown.config.ts`

**Interfaces:**
- Produces: `resolveCursorConfig(env, home, packageRoot): CursorConfig`
- Produces: `main(argv, io): Promise<number>`

- [x] **Step 1: Write the failing config and CLI routing tests**

```ts
it("默认路径与 Gateway 配置保持现有约定", () => {
  const cfg = resolveCursorConfig({}, "/home/test", "/pkg");
  expect(cfg.rootDir).toBe("/home/test/.memory-tencentdb/cursor");
  expect(cfg.gatewayUrl).toBe("http://127.0.0.1:8420");
  expect(cfg.captureTimeoutMs).toBe(60_000);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/cursor/config.test.ts`
Expected: FAIL because `config.ts` does not exist.

- [x] **Step 3: Implement minimal config, CLI entry and exact dependencies**

```ts
export interface CursorConfig {
  rootDir: string;
  dataDir: string;
  gatewayUrl: string;
  gatewayApiKey?: string;
  captureTimeoutMs: number;
  ctlPath: string;
  executablePath: string;
}
```

- [x] **Step 4: Run targeted tests**

Run: `npx vitest run src/adapters/cursor/config.test.ts`
Expected: PASS.

### Task 2: Pending JSONL、上下文与 Hook

**Files:**
- Create: `src/adapters/cursor/pending.ts`
- Create: `src/adapters/cursor/context.ts`
- Create: `src/adapters/cursor/logger.ts`
- Create: `src/adapters/cursor/hooks.ts`
- Create: `src/adapters/cursor/pending.test.ts`
- Create: `src/adapters/cursor/hooks.test.ts`

**Interfaces:**
- Produces: `pendingKey(conversationId, generationId): string`
- Produces: `appendPendingEvent(path, event): Promise<void>`
- Produces: `foldPending(text): FoldedCapture | undefined`
- Produces: `buildSessionContext(dataDir): Promise<string | undefined>`
- Produces: `handleHook(payload, deps): Promise<Record<string, unknown>>`

- [x] **Step 1: Write failing pending/context/Hook tests**

```ts
it("截断行后仍折叠后续完整事件", () => {
  expect(foldPending("\n{broken\n" + validTurn)).toEqual({
    conversationId: "c1",
    generationId: "g1",
    userContent: "u",
    assistantContent: "a1\n\na2",
  });
});

it("只有 stop 唤醒 worker", async () => {
  await handleHook(stopPayload, deps);
  expect(deps.spawnWorker).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/adapters/cursor/pending.test.ts src/adapters/cursor/hooks.test.ts`
Expected: FAIL because modules do not exist.

- [x] **Step 3: Implement one-write O_APPEND and fail-open Hook routing**

```ts
const line = Buffer.from(`\n${JSON.stringify(event)}\n`, "utf8");
const handle = await open(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
const result = await handle.write(line, 0, line.length, null);
```

- [x] **Step 4: Run targeted tests**

Run: `npx vitest run src/adapters/cursor/pending.test.ts src/adapters/cursor/hooks.test.ts`
Expected: PASS.

### Task 3: Gateway 请求与 detached one-shot

**Files:**
- Create: `src/adapters/cursor/gateway.ts`
- Create: `src/adapters/cursor/worker.ts`
- Create: `src/adapters/cursor/worker.test.ts`

**Interfaces:**
- Produces: `gatewayRequest(path, body, config, fetchImpl): Promise<GatewayResult>`
- Produces: `runWorker(options): Promise<void>`
- Consumes: `foldPending(text): FoldedCapture | undefined`

- [x] **Step 1: Write failing HTTP outcome, TTL and lock serialization tests**

```ts
it("2xx 包括 l0_recorded 0 都删除完整 pending", async () => {
  await runWorker(harness({ status: 200, body: { l0_recorded: 0 } }));
  await expect(access(pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it("未知错误保留完整 pending", async () => {
  await runWorker(harness({ status: 409, body: {} }));
  await expect(access(pendingFile)).resolves.toBeUndefined();
});
```

- [x] **Step 2: Run test to verify RED**

Run: `npx vitest run src/adapters/cursor/worker.test.ts`
Expected: FAIL because `worker.ts` does not exist.

- [x] **Step 3: Implement global lock, ctl start, serial drain and best-effort session end**

```ts
const release = await lockfile.lock(config.rootDir, {
  realpath: false,
  stale: 180_000,
  update: 10_000,
  retries: { retries: Number.POSITIVE_INFINITY, minTimeout: 50, maxTimeout: 1_000 },
  onCompromised: markCompromised,
});
```

- [x] **Step 4: Run targeted tests**

Run: `npx vitest run src/adapters/cursor/worker.test.ts`
Expected: PASS with serialized owners and retained retryable pending.

### Task 4: Read-only stdio MCP bridge

**Files:**
- Create: `src/adapters/cursor/mcp.ts`
- Create: `src/adapters/cursor/mcp.test.ts`

**Interfaces:**
- Produces: `createCursorMcpServer(config, request): Server`
- Registers: `tdai_memory_search`
- Registers: `tdai_conversation_search`

- [x] **Step 1: Write failing tool registration and request mapping tests**

```ts
it("只注册两个只读检索工具", async () => {
  expect(await listToolNames(server)).toEqual([
    "tdai_conversation_search",
    "tdai_memory_search",
  ]);
});
```

- [x] **Step 2: Run test to verify RED**

Run: `npx vitest run src/adapters/cursor/mcp.test.ts`
Expected: FAIL because `mcp.ts` does not exist.

- [x] **Step 3: Implement SDK stdio server and POST mapping**

```ts
server.registerTool("tdai_memory_search", schema, async (args) => {
  const result = await request("/search/memories", args);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
```

- [x] **Step 4: Run targeted tests**

Run: `npx vitest run src/adapters/cursor/mcp.test.ts`
Expected: PASS.

### Task 5: 安装、卸载与 spike 证据采集

**Files:**
- Create: `src/adapters/cursor/installer.ts`
- Create: `src/adapters/cursor/installer.test.ts`
- Create: `src/adapters/cursor/spike.ts`
- Create: `src/adapters/cursor/spike.test.ts`

**Interfaces:**
- Produces: `installCursorAdapter(options): Promise<void>`
- Produces: `uninstallCursorAdapter(options): Promise<void>`
- Produces: `recordSpikeEvent(payload, outputDir): Promise<void>`

- [x] **Step 1: Write failing safe-merge and duplicate-scope tests**

```ts
it("另一作用域已有固定标识时拒绝安装", async () => {
  await expect(installCursorAdapter(options)).rejects.toThrow(
    /tencentdb-memory-cursor-v1/,
  );
});

it("卸载只删除 Adapter 自己的配置", async () => {
  await uninstallCursorAdapter(options);
  expect(readHooks()).toMatchObject({ hooks: { stop: [{ command: "other" }] } });
});
```

- [x] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/adapters/cursor/installer.test.ts src/adapters/cursor/spike.test.ts`
Expected: FAIL because modules do not exist.

- [x] **Step 3: Implement atomic JSON merge, Rule management and bounded spike recorder**

```ts
const marker = "tencentdb-memory-cursor-v1";
const command = `${executablePath} hook ${marker}`;
```

- [x] **Step 4: Run targeted tests**

Run: `npx vitest run src/adapters/cursor/installer.test.ts src/adapters/cursor/spike.test.ts`
Expected: PASS.

### Task 6: 集成、构建与需求复核

**Files:**
- Modify: `src/adapters/index.ts`
- Modify: `package.json`
- Test: `src/adapters/cursor/*.test.ts`

**Interfaces:**
- Produces: publishable `memory-tencentdb-cursor` executable.

- [x] **Step 1: Run Cursor Adapter suite**

Run: `npx vitest run src/adapters/cursor`
Expected: PASS.

- [x] **Step 2: Run full unit suite**

Run: `npm test`
Expected: PASS with zero failures.

- [x] **Step 3: Build package and smoke-test executable**

Run: `npm run build && node bin/memory-tencentdb-cursor.mjs --help`
Expected: build exit 0 and help lists `hook`, `worker`, `mcp`, `install`, `uninstall`, `spike`.

- [x] **Step 4: Re-read PRD acceptance criteria**

Expected: code and automated tests cover criteria 1-8 and 10; criterion 9 remains explicitly pending until a human-driven real Cursor IDE spike records evidence.
