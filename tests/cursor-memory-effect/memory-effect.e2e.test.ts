/**
 * Cursor Adapter 记忆效果自动化（开发沙箱可随时 reset）。
 *
 * - 默认：mock Gateway，不依赖本机 :8420 / LLM
 * - 可选：MEMORY_EFFECT_LIVE=1 且 Gateway /health 可用时跑 live capture+search
 *
 * 运行：
 *   npm run test:memory-effect
 *   MEMORY_EFFECT_LIVE=1 npm run test:memory-effect
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayRequest } from "../../src/adapters/cursor/gateway.js";
import { runWorker } from "../../src/adapters/cursor/worker.js";
import {
  PERSONA_MARKER,
  SCENE_FILENAME,
  createTempSandbox,
  drainWorkerWithMockCapture,
  liveEnabled,
  liveGatewayBaseUrl,
  listPendingFiles,
  postJson,
  readPendingBodies,
  resetSandbox,
  runSessionStart,
  runStopCapture,
  startFakeGateway,
  waitFor,
  writeClosedTranscript,
  type HookRunLog,
} from "./helpers.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    if (dispose) await dispose();
  }
});

describe("memory-effect (sandbox, mock gateway)", () => {
  it("reset 沙箱后 sessionStart 注入 L3/L2/工具提示", async () => {
    const sandbox = await createTempSandbox();
    disposers.push(sandbox.dispose);

    const response = await runSessionStart(sandbox, "conv-inject");
    const context = String(response.additional_context ?? "");

    expect(context).toContain(PERSONA_MARKER);
    expect(context).toContain("tdai_memory_search");
    expect(context).toContain(
      path.join(sandbox.dataDir, "scene_blocks", SCENE_FILENAME),
    );
    expect(context).toContain(sandbox.token);
  });

  it("sessionStart → stop(transcript) → pending → worker 投递三字段后清空 pending", async () => {
    const sandbox = await createTempSandbox();
    disposers.push(sandbox.dispose);
    const conversationId = `conv-${sandbox.token.toLowerCase()}`;
    const generationId = `gen-${Date.now()}`;
    const log: HookRunLog[] = [];
    const captures: Array<Record<string, unknown>> = [];

    await runSessionStart(sandbox, conversationId, log);

    const transcriptPath = await writeClosedTranscript({
      projectsRoot: sandbox.projectsRoot,
      conversationId,
      userText: sandbox.rememberPrompt,
      assistantText: `已确认：${sandbox.token}`,
    });

    const spawned = { count: 0 };
    await runStopCapture(
      sandbox,
      { conversationId, generationId, transcriptPath },
      log,
      spawned,
    );

    expect(spawned.count).toBe(1);
    expect(await listPendingFiles(sandbox.cursorRoot)).toHaveLength(1);
    const pendingBody = (await readPendingBodies(sandbox.cursorRoot)).join("\n");
    expect(pendingBody).toContain(sandbox.token);
    expect(pendingBody).toContain('"event":"stop"');

    await drainWorkerWithMockCapture(sandbox, captures, log);

    expect(captures).toHaveLength(1);
    expect(captures[0]).toEqual({
      user_content: sandbox.rememberPrompt,
      assistant_content: `已确认：${sandbox.token}`,
      session_key: `cursor:${conversationId}`,
    });
    expect(Object.keys(captures[0]!).sort()).toEqual([
      "assistant_content",
      "session_key",
      "user_content",
    ]);
    expect(await listPendingFiles(sandbox.cursorRoot)).toEqual([]);
    expect(log.some((entry) => entry.event === "capture_acked")).toBe(true);
  });

  it("未 sessionStart 的 stop 不写 pending（fail-closed）", async () => {
    const sandbox = await createTempSandbox();
    disposers.push(sandbox.dispose);
    const conversationId = "conv-unclassified";
    const log: HookRunLog[] = [];

    const transcriptPath = await writeClosedTranscript({
      projectsRoot: sandbox.projectsRoot,
      conversationId,
      userText: sandbox.rememberPrompt,
      assistantText: "ok",
    });

    await runStopCapture(
      sandbox,
      {
        conversationId,
        generationId: "gen-1",
        transcriptPath,
      },
      log,
    );

    expect(await listPendingFiles(sandbox.cursorRoot)).toEqual([]);
    expect(log.some((entry) => entry.event === "stop_skipped_unclassified")).toBe(
      true,
    );
  });

  it("固定 .sandbox 可 reset 并复用（开发调试）", async () => {
    const first = await resetSandbox("MEMFX-RESET-A");
    expect(first.token).toBe("MEMFX-RESET-A");
    const second = await resetSandbox("MEMFX-RESET-B");
    expect(second.token).toBe("MEMFX-RESET-B");
    const persona = await runSessionStart(second, "conv-sandbox-reset");
    expect(String(persona.additional_context)).toContain("MEMFX-RESET-B");
    expect(String(persona.additional_context)).not.toContain("MEMFX-RESET-A");
  });

  it("假 Gateway HTTP 路径：worker 真发 /capture", async () => {
    const sandbox = await createTempSandbox();
    disposers.push(sandbox.dispose);
    const fake = await startFakeGateway();
    disposers.push(fake.close);
    sandbox.config.gatewayUrl = fake.url;

    const conversationId = "conv-http-fake";
    await runSessionStart(sandbox, conversationId);
    const transcriptPath = await writeClosedTranscript({
      projectsRoot: sandbox.projectsRoot,
      conversationId,
      userText: sandbox.rememberPrompt,
      assistantText: `acked ${sandbox.token}`,
    });
    await runStopCapture(sandbox, {
      conversationId,
      generationId: "gen-http",
      transcriptPath,
    });

    const log: HookRunLog[] = [];
    await runWorker({
      config: sandbox.config,
      startGateway: async () => true,
      request: (route, body) => gatewayRequest(route, body, sandbox.config),
      log: (event, fields) => log.push({ event, fields }),
    });

    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0]).toMatchObject({
      user_content: sandbox.rememberPrompt,
      session_key: `cursor:${conversationId}`,
    });
    expect(await listPendingFiles(sandbox.cursorRoot)).toEqual([]);
    expect(log.some((entry) => entry.event === "capture_acked")).toBe(true);
  });
});

describe("memory-effect (live gateway)", () => {
  it.skipIf(!liveEnabled())(
    "LIVE：真实 Gateway capture 后 conversation search 命中口令",
    async () => {
      const baseUrl = await liveGatewayBaseUrl();
      if (!baseUrl) {
        throw new Error(
          "MEMORY_EFFECT_LIVE=1 但 Gateway /health 不可用；请先 ctl start",
        );
      }

      const sandbox = await createTempSandbox();
      disposers.push(sandbox.dispose);
      sandbox.config.gatewayUrl = baseUrl;

      const conversationId = `live-${sandbox.token.toLowerCase()}`;
      await runSessionStart(sandbox, conversationId);
      const transcriptPath = await writeClosedTranscript({
        projectsRoot: sandbox.projectsRoot,
        conversationId,
        userText: sandbox.rememberPrompt,
        assistantText: `已确认：${sandbox.token}`,
      });
      await runStopCapture(sandbox, {
        conversationId,
        generationId: `gen-live-${Date.now()}`,
        transcriptPath,
      });

      const log: HookRunLog[] = [];
      await runWorker({
        config: sandbox.config,
        // 假定 Gateway 已在跑；不调用 ctl，避免动开发机全局状态
        startGateway: async () => true,
        request: (route, body) => gatewayRequest(route, body, sandbox.config),
        log: (event, fields) => log.push({ event, fields }),
      });

      expect(log.some((entry) => entry.event === "capture_acked")).toBe(true);
      expect(await listPendingFiles(sandbox.cursorRoot)).toEqual([]);

      await waitFor(
        "conversation search hit",
        async () => {
          const { status, json } = await postJson(
            baseUrl,
            "/search/conversations",
            { query: sandbox.token, limit: 5 },
          );
          if (status < 200 || status >= 300) return false;
          const text = JSON.stringify(json);
          return text.includes(sandbox.token);
        },
        { timeoutMs: 20_000, intervalMs: 500 },
      );
    },
  );
});
