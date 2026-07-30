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
    appendTranscript: vi.fn().mockResolvedValue("/pending/key.jsonl"),
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
  // Help exposes the full but minimal subcommand set.
  it("prints subcommand help", async () => {
    const io = runtime();

    expect(await main(["--help"], io)).toBe(0);

    const output = vi.mocked(io.writeStdout).mock.calls.join("\n");
    for (const command of ["hook", "worker", "mcp", "install", "uninstall", "spike"]) {
      expect(output).toContain(command);
    }
  });

  // After foreground append on stop, only spawn a detached worker.
  it("hook stop wakes a detached worker", async () => {
    const io = runtime(JSON.stringify({
      hook_event_name: "stop",
      conversation_id: "c1",
      generation_id: "g1",
      status: "completed",
      transcript_path: "/transcript.jsonl",
    }));

    expect(await main(["hook", "tencentdb-memory-cursor-v1"], io)).toBe(0);

    expect(io.spawnDetached).toHaveBeenCalledWith(["worker"]);
    expect(io.writeStdout).toHaveBeenCalledWith("{}\n");
  });

  // Invalid Hook input must fail-open with valid JSON on stdout.
  it("fail-opens on invalid Hook JSON", async () => {
    const io = runtime("sensitive-prompt-is-not-json");

    expect(await main(["hook"], io)).toBe(0);

    expect(io.writeStdout).toHaveBeenCalledWith("{}\n");
    expect(JSON.stringify(vi.mocked(io.log).mock.calls)).not.toContain(
      "sensitive-prompt",
    );
    expect(io.log).toHaveBeenCalledWith("hook_input_error", {
      reason: "invalid_json",
    });
  });

  // Spike stop events also emit detached liveness evidence.
  it("spike stop starts a detached sentinel", async () => {
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

  // sessionStart must inject a fixed marker so first-turn visibility can be verified by hand.
  it("spike sessionStart returns an additional_context marker", async () => {
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
