import { describe, expect, it, vi } from "vitest";
import { main, type CursorCliRuntime } from "./cli.js";

function runtime(payload = "{}"): CursorCliRuntime {
  return {
    readStdin: vi.fn().mockResolvedValue(payload),
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    spawnDetached: vi.fn(),
    runMcp: vi.fn().mockResolvedValue(undefined),
    runWorker: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    recordSpike: vi.fn().mockResolvedValue("/spike/hook-events.jsonl"),
    writeDetachedEvidence: vi.fn().mockResolvedValue(undefined),
    appendPending: vi.fn().mockResolvedValue("/pending/key.jsonl"),
    buildContext: vi.fn().mockResolvedValue("context"),
    log: vi.fn(),
    env: {},
    home: "/home/test",
    cwd: "/project",
    packageRoot: "/pkg",
    executablePath: "/bin/memory-tencentdb-cursor",
    now: () => 1,
  };
}

describe("memory-tencentdb-cursor CLI", () => {
  // help 暴露完整但最小的子命令集合.
  it("输出子命令帮助", async () => {
    const io = runtime();

    expect(await main(["--help"], io)).toBe(0);

    const output = vi.mocked(io.writeStdout).mock.calls.join("\n");
    for (const command of ["hook", "worker", "mcp", "install", "uninstall", "spike"]) {
      expect(output).toContain(command);
    }
  });

  // stop 在前台追加后只 detached spawn worker.
  it("hook stop 唤醒 detached worker", async () => {
    const io = runtime(JSON.stringify({
      hook_event_name: "stop",
      conversation_id: "c1",
      generation_id: "g1",
      status: "completed",
    }));

    expect(await main(["hook", "tencentdb-memory-cursor-v1"], io)).toBe(0);

    expect(io.spawnDetached).toHaveBeenCalledWith(["worker"]);
    expect(io.writeStdout).toHaveBeenCalledWith("{}\n");
  });

  // 无效 Hook 输入必须 fail-open, stdout 仍是合法 JSON.
  it("无效 Hook JSON fail-open", async () => {
    const io = runtime("{broken");

    expect(await main(["hook"], io)).toBe(0);

    expect(io.writeStdout).toHaveBeenCalledWith("{}\n");
  });

  // spike 的 stop 事件额外生成 detached 存活证据.
  it("spike stop 启动 detached sentinel", async () => {
    const io = runtime(JSON.stringify({
      hook_event_name: "stop",
      conversation_id: "c1",
      generation_id: "g1",
    }));

    expect(await main(["spike"], io)).toBe(0);

    expect(io.spawnDetached).toHaveBeenCalledWith([
      "spike-sentinel",
      "/home/test/.memory-tencentdb/cursor/spike",
    ]);
  });

  // sessionStart 必须注入固定标记, 才能人工验证首轮可见性.
  it("spike sessionStart 返回 additional_context 标记", async () => {
    const io = runtime(JSON.stringify({
      hook_event_name: "sessionStart",
      conversation_id: "c1",
    }));

    expect(await main(["spike"], io)).toBe(0);

    expect(io.writeStdout).toHaveBeenCalledWith(
      `${JSON.stringify({
        additional_context:
          "SPIKE_MARKER_tencentdb-memory-cursor-v1 first_turn_visible",
      })}\n`,
    );
  });
});
