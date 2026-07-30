# Cursor Adapter Reviewer01 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 reviewer01 中已确认的 Cursor Adapter 会话分类、worker 可靠性、输入安全和类型问题。

**Architecture:** `sessionStart` 写入哈希命名的顶层会话 marker，`stop` fail-closed 检查后再读取受限 transcript。Worker 使用有限锁等待和重复扫描；日志只保存固定分类或 bounded 元数据。

**Tech Stack:** TypeScript、Node.js 22.16、Vitest、proper-lockfile 4.1.2

## Global Constraints

- 不修改 Gateway、TdaiCore、L0。
- capture 只发送 `user_content`、`assistant_content`、`session_key`。
- 前台 Hook 不执行网络并保持 fail-open。
- Hook timeout 与真 Background Agent 继续作为发布门禁。
- 所有行为修改先写失败测试。

---

### Task 1: 会话分类与 transcript 根路径

**Files:**
- Create: `src/adapters/cursor/session.ts`
- Create: `src/adapters/cursor/session.test.ts`
- Modify: `src/adapters/cursor/config.ts`
- Modify: `src/adapters/cursor/config.test.ts`
- Modify: `src/adapters/cursor/pending.ts`
- Modify: `src/adapters/cursor/pending.test.ts`
- Modify: `src/adapters/cursor/hooks.ts`
- Modify: `src/adapters/cursor/hooks.test.ts`
- Modify: `src/adapters/cursor/cli.ts`
- Modify: `src/adapters/cursor/cli.test.ts`

**Interfaces:**
- Produces: `markTopLevelSession(rootDir, conversationId): Promise<void>`
- Produces: `isTopLevelSession(rootDir, conversationId): Promise<boolean>`
- Produces: `clearSessionMarker(rootDir, conversationId): Promise<void>`
- Adds: `CursorConfig.transcriptsRoot: string`
- Changes: `appendTranscriptTurn(rootDir, transcriptsRoot, transcriptPath, conversationId, generationId, status, atMs)`

- [x] **Step 1: Write failing session, Hook, config and path tests**

```ts
await handleHook(sessionStart({ is_background_agent: false }), deps);
expect(await isTopLevelSession(root, "c1")).toBe(true);
await handleHook(stop(), deps);
expect(appendTranscript).toHaveBeenCalledOnce();

await handleHook(stop({ conversation_id: "unknown" }), deps);
expect(appendTranscript).not.toHaveBeenCalled();

expect(resolveCursorConfig({}, "/home/test", "/pkg", "/bin/cursor").transcriptsRoot)
  .toBe("/home/test/.cursor/projects");
```

- [x] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/adapters/cursor/session.test.ts src/adapters/cursor/hooks.test.ts src/adapters/cursor/config.test.ts src/adapters/cursor/pending.test.ts`

Expected: FAIL because session marker APIs and `transcriptsRoot` do not exist.

- [x] **Step 3: Implement minimal marker and root enforcement**

```ts
export function sessionMarkerPath(rootDir: string, conversationId: string): string {
  return path.join(rootDir, "sessions", `${sha256(conversationId)}.top-level`);
}

if (event === "sessionStart") {
  if (payload.is_background_agent !== false) {
    await clearSessionMarker(deps.rootDir, conversationId);
    return {};
  }
  await markTopLevelSession(deps.rootDir, conversationId);
  return context ? { additional_context: context } : {};
}

if (!(await isTopLevelSession(deps.rootDir, conversationId))) {
  deps.log("stop_skipped_unclassified");
  deps.spawnWorker();
  return {};
}
```

- [x] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run src/adapters/cursor/session.test.ts src/adapters/cursor/hooks.test.ts src/adapters/cursor/config.test.ts src/adapters/cursor/pending.test.ts src/adapters/cursor/cli.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/adapters/cursor/session.ts src/adapters/cursor/session.test.ts src/adapters/cursor/config.ts src/adapters/cursor/config.test.ts src/adapters/cursor/pending.ts src/adapters/cursor/pending.test.ts src/adapters/cursor/hooks.ts src/adapters/cursor/hooks.test.ts src/adapters/cursor/cli.ts src/adapters/cursor/cli.test.ts
git commit -m "fix: classify Cursor sessions before capture"
```

### Task 2: Worker 有限等待与可靠清理

**Files:**
- Modify: `src/adapters/cursor/worker.ts`
- Modify: `src/adapters/cursor/worker.test.ts`

**Interfaces:**
- Changes: `LockOptions.retries` to finite retry options.
- Preserves: `runWorker(options): Promise<void>`

- [x] **Step 1: Write failing worker tests**

```ts
expect(acquireLock).toHaveBeenCalledWith(
  config.rootDir,
  expect.objectContaining({
    retries: expect.objectContaining({ retries: 120, forever: undefined }),
  }),
);

release.mockRejectedValue(Object.assign(new Error("released"), { code: "ERELEASED" }));
await expect(runWorker(options)).resolves.toBeUndefined();
expect(options.log).toHaveBeenCalledWith("lock_release_error", expect.any(Object));

await runWorker(optionsWithPendingCreatedAfterFirstScan);
expect(options.request).toHaveBeenCalledTimes(2);
```

- [x] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/adapters/cursor/worker.test.ts`

Expected: FAIL because retries are infinite, release rejects and worker scans once.

- [x] **Step 3: Implement finite retry, rescan and deletion logging**

```ts
retries: {
  retries: 120,
  factor: 1,
  minTimeout: 1_000,
  maxTimeout: 1_000,
},

try {
  await unlink(pending.path);
} catch (error) {
  options.log("pending_delete_failed", boundedError(error));
  retained = true;
  break;
}

try {
  await release();
} catch (error) {
  options.log("lock_release_error", boundedError(error));
}
```

- [x] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run src/adapters/cursor/worker.test.ts src/adapters/cursor/worker-lock.e2e.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/adapters/cursor/worker.ts src/adapters/cursor/worker.test.ts
git commit -m "fix: bound Cursor worker lock waits"
```

### Task 3: 输入日志与类型收紧

**Files:**
- Modify: `src/adapters/cursor/cli.ts`
- Modify: `src/adapters/cursor/cli.test.ts`
- Modify: `src/adapters/cursor/installer.ts`
- Modify: `src/adapters/cursor/mcp.test.ts`

**Interfaces:**
- Preserves all production CLI and installer signatures.
- Changes installer JSON representation to `Record<string, unknown>`.

- [x] **Step 1: Write failing sensitive-log and type tests**

```ts
await main(["hook"], runtime('{"secret":"value",broken'));
expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
expect(log).toHaveBeenCalledWith("hook_input_error", { reason: "invalid_json" });
```

Run: `npx vitest run src/adapters/cursor/cli.test.ts`

Expected: FAIL because the raw JSON parser message is logged.

- [x] **Step 2: Implement fixed error classification**

```ts
runtime.log("hook_input_error", {
  reason: error instanceof SyntaxError ? "invalid_json" : "invalid_payload",
});
```

- [x] **Step 3: Tighten installer and MCP test types**

```ts
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

type RequestGateway = NonNullable<Parameters<typeof createCursorMcpServer>[1]>;
```

- [x] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/adapters/cursor/cli.test.ts src/adapters/cursor/installer.test.ts src/adapters/cursor/mcp.test.ts`

Run: `npx tsc --noEmit --pretty false 2>&1 | rg "src/adapters/cursor"`

Expected: tests PASS; no Cursor source errors.

- [x] **Step 5: Commit**

```bash
git add src/adapters/cursor/cli.ts src/adapters/cursor/cli.test.ts src/adapters/cursor/installer.ts src/adapters/cursor/mcp.test.ts
git commit -m "fix: harden Cursor input and config types"
```

### Task 4: 文档同步与全量验证

**Files:**
- Modify: `docs/316base/prd.md`
- Modify: `docs/316base/spec.md`
- Modify: `docs/superpowers/plans/2026-07-30-cursor-adapter.md`

**Interfaces:**
- Documents the implemented session marker, finite wait and strict transcript root.

- [x] **Step 1: Update current behavior**

```text
sessionStart(false) → top-level marker
stop → require marker → transcript → pending
sessionEnd → wake worker → clear marker
```

- [x] **Step 2: Run full verification**

Run: `npx vitest run src/adapters/cursor`

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Expected: all commands exit 0.

- [x] **Step 3: Commit**

```bash
git add docs/316base/prd.md docs/316base/spec.md docs/superpowers/plans/2026-07-30-cursor-adapter.md
git commit -m "docs: sync Cursor reviewer remediations"
```
