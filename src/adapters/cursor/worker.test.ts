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
    transcriptsRoot: path.join(rootDir, ".cursor", "projects"),
  };
}

async function completePending(config: CursorConfig): Promise<string> {
  return completePendingFor(config, "c1", "g1");
}

async function completePendingFor(
  config: CursorConfig,
  conversationId: string,
  generationId: string,
): Promise<string> {
  await appendPendingEvent(config.rootDir, {
    v: 1,
    event: "user",
    conversation_id: conversationId,
    generation_id: generationId,
    text: `问题-${conversationId}`,
    at_ms: 1,
  });
  await appendPendingEvent(config.rootDir, {
    v: 1,
    event: "assistant",
    conversation_id: conversationId,
    generation_id: generationId,
    text: `回答-${conversationId}`,
    at_ms: 2,
  });
  return appendPendingEvent(config.rootDir, {
    v: 1,
    event: "stop",
    conversation_id: conversationId,
    generation_id: generationId,
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
  // Thin HTTP wrapper only adds JSON and optional Bearer; business body unchanged.
  it("sends JSON Bearer and timeout", async () => {
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

  // Network errors must become decidable results; worker must not delete pending.
  it("returns a bounded network error", async () => {
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
  // Any 2xx is an ACK, including when l0_recorded is 0.
  it("deletes complete pending on 2xx with only three request fields", async () => {
    const config = await makeConfig();
    const file = await completePending(config);
    const options = harness(config, { status: 200, body: { l0_recorded: 0 } });

    await runWorker(options);

    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(options.request).toHaveBeenCalledWith("/capture", {
      user_content: "问题-c1",
      assistant_content: "回答-c1",
      session_key: "cursor:c1",
    });
  });

  // Retryable auth/version and unknown errors must keep complete pending.
  it.each([undefined, 408, 409, 425, 429, 500, 401, 403, 404, 405])(
    "status %s keeps complete pending",
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

  // Clearly permanent invalid requests are logged then deleted so work continues.
  it.each([400, 413, 415, 422])(
    "permanent status %s deletes pending",
    async (statusCode) => {
      const config = await makeConfig();
      const file = await completePending(config);

      await runWorker(harness(config, { status: statusCode, body: { error: "invalid" } }));

      await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // Permanent-error logs must not keep request bodies Gateway may echo.
  it("permanent-error logs omit response body", async () => {
    const config = await makeConfig();
    await completePending(config);
    const options = harness(config, {
      status: 400,
      body: { error: "敏感问题和回答" },
    });

    await runWorker(options);

    expect(JSON.stringify(vi.mocked(options.log).mock.calls)).not.toContain("敏感问题和回答");
  });

  // Incomplete pending expires by TTL; complete pending is not TTL-cleaned.
  it("expires only incomplete pending after 24h TTL", async () => {
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

  // Without a complete turn or sessionEnd, Gateway must not start.
  it("skips Gateway start on empty scan", async () => {
    const config = await makeConfig();
    const options = harness(config, { status: 200 });

    await runWorker(options);

    expect(options.startGateway).not.toHaveBeenCalled();
    expect(options.request).not.toHaveBeenCalled();
  });

  // sessionEnd is best-effort; failure must not create a local marker.
  it("does not persist state after sessionEnd failure", async () => {
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

  // stale must cover long requests, but waiters must not live forever.
  it("configures heartbeat and a finite 120s lock wait", async () => {
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
      retries: {
        retries: 120,
        factor: 1,
        minTimeout: 1_000,
        maxTimeout: 1_000,
      },
      onCompromised: expect.any(Function),
    }));
  });

  // Pending added while the owner works must be rescanned by the same owner.
  it("rescans newly added pending after success", async () => {
    const config = await makeConfig();
    await completePendingFor(config, "c1", "g1");
    let createdSecond = false;
    const request = vi.fn(async () => {
      if (!createdSecond) {
        createdSecond = true;
        await completePendingFor(config, "c2", "g2");
      }
      return { status: 200 };
    });
    const options = harness(config, { status: 200 });
    options.request = request;

    await runWorker(options);

    expect(request).toHaveBeenCalledTimes(2);
  });

  // Local delete failure after ACK must not report success or resend immediately.
  it("retains pending and logs when delete fails", async () => {
    const config = await makeConfig();
    const file = await completePending(config);
    const remove = vi.fn().mockRejectedValue(new Error("permission denied"));
    const options = {
      ...harness(config, { status: 200 }),
      remove,
    };

    await runWorker(options);

    await expect(access(file)).resolves.toBeUndefined();
    expect(options.log).toHaveBeenCalledWith(
      "pending_delete_failed",
      expect.objectContaining({ error: "permission denied" }),
    );
    expect(options.log).not.toHaveBeenCalledWith(
      "capture_acked",
      expect.anything(),
    );
  });

  // Compromised locks are already released by the library; ERELEASED on release is log-only.
  it("release failures do not escape the worker", async () => {
    const config = await makeConfig();
    const release = vi.fn().mockRejectedValue(
      Object.assign(new Error("already released"), { code: "ERELEASED" }),
    );
    const options = harness(config, { status: 200 });
    options.acquireLock = vi.fn().mockResolvedValue(release);
    options.sessionEndKey = "cursor:c1";

    await expect(runWorker(options)).resolves.toBeUndefined();

    expect(options.log).toHaveBeenCalledWith(
      "lock_release_error",
      expect.objectContaining({ error: "already released" }),
    );
  });

  // Exhausted lock retries only exit this worker; pending waits for later events.
  it("logs and exits when lock acquire fails", async () => {
    const config = await makeConfig();
    const options = harness(config, { status: 200 });
    options.acquireLock = vi.fn().mockRejectedValue(new Error("lock timeout"));

    await expect(runWorker(options)).resolves.toBeUndefined();

    expect(options.log).toHaveBeenCalledWith(
      "lock_acquire_failed",
      expect.objectContaining({ error: "lock timeout" }),
    );
  });

  // Two one-shots must serialize on the same owner region.
  it("serializes concurrent workers under the global lock", async () => {
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
