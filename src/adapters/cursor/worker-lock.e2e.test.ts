import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CursorConfig } from "./config.js";
import { appendPendingEvent } from "./pending.js";
import { runWorker } from "./worker.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("proper-lockfile heartbeat", () => {
  // 实际持锁超过 60 秒时, 第二个 one-shot 仍不能成为 owner.
  it("长请求期间不发生 stale 接管", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "cursor-lock-e2e-"));
    tempDirs.push(rootDir);
    const config: CursorConfig = {
      rootDir,
      dataDir: path.join(rootDir, "data"),
      gatewayUrl: "http://127.0.0.1:8420",
      captureTimeoutMs: 60_000,
      ctlPath: "/ctl",
      executablePath: "/bin/memory-tencentdb-cursor",
      transcriptsRoot: path.join(rootDir, ".cursor", "projects"),
    };
    await appendPendingEvent(rootDir, {
      v: 1,
      event: "user",
      conversation_id: "c1",
      generation_id: "g1",
      text: "问题",
      at_ms: 1,
    });
    await appendPendingEvent(rootDir, {
      v: 1,
      event: "assistant",
      conversation_id: "c1",
      generation_id: "g1",
      text: "回答",
      at_ms: 2,
    });
    await appendPendingEvent(rootDir, {
      v: 1,
      event: "stop",
      conversation_id: "c1",
      generation_id: "g1",
      status: "completed",
      at_ms: 3,
    });

    let activeOwners = 0;
    let maxOwners = 0;
    let requestCount = 0;
    const options = {
      config,
      startGateway: async () => {
        activeOwners += 1;
        maxOwners = Math.max(maxOwners, activeOwners);
        return true;
      },
      request: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 61_000));
        }
        activeOwners -= 1;
        return { status: 500 };
      },
      log: () => undefined,
    };

    const first = runWorker(options);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = runWorker(options);
    await Promise.all([first, second]);

    expect(requestCount).toBe(2);
    expect(maxOwners).toBe(1);
  }, 90_000);
});
