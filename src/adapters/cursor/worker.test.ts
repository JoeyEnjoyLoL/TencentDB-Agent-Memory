import { access, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorConfig } from "./config.js";
import { gatewayRequest } from "./gateway.js";
import { appendPendingEvent, pendingPath } from "./pending.js";
import { runWorker, type WorkerOptions } from "./worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(): Promise<CursorConfig> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "cursor-worker-"));
  tempDirs.push(rootDir);
  return {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    gatewayUrl: "http://127.0.0.1:8420",
    captureTimeoutMs: 60_000,
    ctlPath: "/pkg/scripts/memory-tencentdb-ctl.sh",
    executablePath: "/bin/memory-tencentdb-cursor",
  };
}

async function completePending(config: CursorConfig): Promise<string> {
  await appendPendingEvent(config.rootDir, {
    v: 1,
    event: "user",
    conversation_id: "c1",
    generation_id: "g1",
    text: "问题",
    at_ms: 1,
  });
  await appendPendingEvent(config.rootDir, {
    v: 1,
    event: "assistant",
    conversation_id: "c1",
    generation_id: "g1",
    text: "回答",
    at_ms: 2,
  });
  return appendPendingEvent(config.rootDir, {
    v: 1,
    event: "stop",
    conversation_id: "c1",
    generation_id: "g1",
    status: "completed",
    at_ms: 3,
  });
}

function harness(
  config: CursorConfig,
  result: { status?: number; body?: unknown; error?: string },
): WorkerOptions {
  return {
    config,
    acquireLock: vi.fn().mockResolvedValue(vi.fn()),
    startGateway: vi.fn().mockResolvedValue(true),
    request: vi.fn().mockResolvedValue(result),
    log: vi.fn(),
    now: () => Date.now(),
  };
}

describe("gatewayRequest", () => {
  // HTTP 薄封装只添加 JSON 和可选 Bearer, 不改变业务 body.
  it("发送 JSON Bearer 与 timeout", async () => {
    const config = await makeConfig();
    config.gatewayApiKey = "secret";
    config.captureTimeoutMs = 7_000;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ l0_recorded: 0 }),
      { status: 200 },
    ));

    const result = await gatewayRequest(
      "/capture",
      { user_content: "u" },
      config,
      fetchImpl,
    );

    expect(result).toMatchObject({ status: 200, body: { l0_recorded: 0 } });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8420/capture",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: JSON.stringify({ user_content: "u" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  // 网络异常必须转成可判定结果, 不能让 worker 删除 pending.
  it("返回 bounded 网络错误", async () => {
    const config = await makeConfig();
    const result = await gatewayRequest(
      "/capture",
      {},
      config,
      vi.fn().mockRejectedValue(new Error("x".repeat(1_000))),
    );

    expect(result.status).toBeUndefined();
    expect(result.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("runWorker", () => {
  // 任何 2xx 都是 ACK, 包括 l0_recorded 为 0.
  it("2xx 删除完整 pending 且请求仅含三个字段", async () => {
    const config = await makeConfig();
    const file = await completePending(config);
    const options = harness(config, { status: 200, body: { l0_recorded: 0 } });

    await runWorker(options);

    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(options.request).toHaveBeenCalledWith("/capture", {
      user_content: "问题",
      assistant_content: "回答",
      session_key: "cursor:c1",
    });
  });

  // retryable 鉴权版本和未知错误都必须保留完整 pending.
  it.each([undefined, 408, 409, 425, 429, 500, 401, 403, 404, 405])(
    "状态 %s 保留完整 pending",
    async (statusCode) => {
      const config = await makeConfig();
      const file = await completePending(config);
      const options = harness(
        config,
        statusCode === undefined ? { error: "network" } : { status: statusCode },
      );

      await runWorker(options);

      await expect(access(file)).resolves.toBeUndefined();
    },
  );

  // 明确永久无效的请求记录摘要后删除并继续.
  it.each([400, 413, 415, 422])(
    "永久状态 %s 删除 pending",
    async (statusCode) => {
      const config = await makeConfig();
      const file = await completePending(config);

      await runWorker(harness(config, { status: statusCode, body: { error: "invalid" } }));

      await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // 永久错误日志不能保存 Gateway 可能回显的请求正文.
  it("永久错误日志不包含响应 body", async () => {
    const config = await makeConfig();
    await completePending(config);
    const options = harness(config, {
      status: 400,
      body: { error: "敏感问题和回答" },
    });

    await runWorker(options);

    expect(JSON.stringify(vi.mocked(options.log).mock.calls)).not.toContain("敏感问题和回答");
  });

  // 不完整 pending 过期清理, 完整 pending 不按 TTL 清理.
  it("只按 24 小时 TTL 清理不完整 pending", async () => {
    const config = await makeConfig();
    const incomplete = await appendPendingEvent(config.rootDir, {
      v: 1,
      event: "user",
      conversation_id: "old",
      generation_id: "g1",
      text: "问题",
      at_ms: 1,
    });
    const complete = await completePending(config);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await utimes(incomplete, old, old);
    await utimes(complete, old, old);
    const options = harness(config, { status: 500 });

    await runWorker(options);

    await expect(access(incomplete)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(complete)).resolves.toBeUndefined();
  });

  // 没有完整轮次和 sessionEnd 时不能启动 Gateway.
  it("空扫描不启动 Gateway", async () => {
    const config = await makeConfig();
    const options = harness(config, { status: 200 });

    await runWorker(options);

    expect(options.startGateway).not.toHaveBeenCalled();
    expect(options.request).not.toHaveBeenCalled();
  });

  // sessionEnd 是 best-effort, 失败不产生本地 marker.
  it("sessionEnd 失败后不写持久状态", async () => {
    const config = await makeConfig();
    const options = harness(config, { status: 500 });
    options.sessionEndKey = "cursor:c1";

    await runWorker(options);

    expect(options.request).toHaveBeenCalledWith("/session/end", {
      session_key: "cursor:c1",
    });
    const entries = await readFile(path.join(config.rootDir, ".keep"), "utf8")
      .catch(() => "");
    expect(entries).toBe("");
  });

  // stale 必须长于 Gateway 启动和 60 秒请求, heartbeat 必须持续更新.
  it("配置可覆盖长请求的 proper-lockfile heartbeat", async () => {
    const config = await makeConfig();
    const acquireLock = vi.fn().mockResolvedValue(vi.fn());
    const options = harness(config, { status: 200 });
    options.acquireLock = acquireLock;
    options.sessionEndKey = "cursor:c1";

    await runWorker(options);

    expect(acquireLock).toHaveBeenCalledWith(config.rootDir, expect.objectContaining({
      realpath: false,
      stale: 180_000,
      update: 10_000,
      retries: expect.objectContaining({ forever: true }),
      onCompromised: expect.any(Function),
    }));
  });

  // 两个 one-shot 必须串行持有同一 owner 区域.
  it("并发 worker 在全局锁内串行", async () => {
    const config = await makeConfig();
    let owner = false;
    let maxOwners = 0;
    let owners = 0;
    const waiters: Array<() => void> = [];
    const acquireLock: WorkerOptions["acquireLock"] = async () => {
      if (owner) await new Promise<void>((resolve) => waiters.push(resolve));
      owner = true;
      owners += 1;
      maxOwners = Math.max(maxOwners, owners);
      return async () => {
        owners -= 1;
        owner = false;
        waiters.shift()?.();
      };
    };
    const startGateway = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return true;
    });
    const base = harness(config, { status: 200 });
    base.acquireLock = acquireLock;
    base.startGateway = startGateway;
    base.sessionEndKey = "cursor:c1";

    await Promise.all([runWorker(base), runWorker(base)]);

    expect(maxOwners).toBe(1);
  });
});
