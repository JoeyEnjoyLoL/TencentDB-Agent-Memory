import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendPendingEvent,
  appendTranscriptTurn,
  extractTranscriptTurn,
  foldPending,
  pendingKey,
  pendingPath,
} from "./pending.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function validTurn(): string {
  return [
    JSON.stringify({
      v: 1,
      event: "user",
      conversation_id: "c1",
      generation_id: "g1",
      text: "问题",
      at_ms: 1,
    }),
    JSON.stringify({
      v: 1,
      event: "assistant",
      conversation_id: "c1",
      generation_id: "g1",
      text: "回答一",
      at_ms: 2,
    }),
    JSON.stringify({
      v: 1,
      event: "assistant",
      conversation_id: "c1",
      generation_id: "g1",
      text: "回答二",
      at_ms: 3,
    }),
    JSON.stringify({
      v: 1,
      event: "stop",
      conversation_id: "c1",
      generation_id: "g1",
      status: "completed",
      at_ms: 4,
    }),
  ].join("\n");
}

describe("pending JSONL", () => {
  // IDs must not enter filenames; avoids path traversal and length issues.
  it("builds stable filenames from canonical JSON sha256", () => {
    expect(pendingKey("../会话", "轮次/1")).toMatch(/^[0-9a-f]{64}$/);
    expect(pendingKey("../会话", "轮次/1")).toBe(pendingKey("../会话", "轮次/1"));
    expect(pendingKey("../会话", "轮次/2")).not.toBe(pendingKey("../会话", "轮次/1"));
  });

  // Each Hook appends one complete Buffer with leading and trailing newlines.
  it("appends events with leading and trailing newlines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-pending-"));
    tempDirs.push(root);
    const event = {
      v: 1 as const,
      event: "user" as const,
      conversation_id: "c1",
      generation_id: "g1",
      text: "问题",
      at_ms: 1,
    };

    const file = await appendPendingEvent(root, event);

    expect(file).toBe(pendingPath(root, "c1", "g1"));
    expect(await readFile(file, "utf8")).toBe(`\n${JSON.stringify(event)}\n`);
  });

  // Truncated/invalid lines must not hide later complete events.
  it("skips truncated lines and folds the first complete turn", () => {
    const folded = foldPending(`\n{"broken":\n\n${validTurn()}\n`);

    expect(folded).toEqual({
      conversationId: "c1",
      userContent: "问题",
      assistantContent: "回答一\n\n回答二",
    });
  });

  // Missing any closing element keeps the turn undeliverable.
  it("stays incomplete without user, assistant, or stop", () => {
    const lines = validTurn().split("\n");

    expect(foldPending(lines.slice(1).join("\n"))).toBeUndefined();
    expect(foldPending([lines[0], lines[3]].join("\n"))).toBeUndefined();
    expect(foldPending(lines.slice(0, 3).join("\n"))).toBeUndefined();
  });

  // First stop seals the turn; later records must not enter the same capture.
  it("ignores duplicate user/stop and post-stop records", () => {
    const extra = [
      validTurn(),
      JSON.stringify({
        v: 1,
        event: "assistant",
        conversation_id: "c1",
        generation_id: "g1",
        text: "过晚回答",
        at_ms: 5,
      }),
    ].join("\n");

    expect(foldPending(extra)?.assistantContent).toBe("回答一\n\n回答二");
  });

  // stop transcript restores only the current turn before the last turn_ended.
  it("unambiguously extracts last-turn user and final assistant from transcript", () => {
    const transcript = [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<timestamp>旧</timestamp>\n<user_query>\n旧问题\n</user_query>" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "旧回答" }] },
      }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
      JSON.stringify({
        role: "user",
        message: {
          content: [{
            type: "text",
            text: "<timestamp>新</timestamp>\n<user_query>\n问题含 </user_query> 字样\n</user_query>",
          }, {
            type: "text",
            text: "非正文附加信息",
          }],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "中间说明" },
            { type: "tool_use", name: "tool", input: {} },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "最终回答" }] },
      }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ].join("\n");

    expect(extractTranscriptTurn(transcript)).toEqual({
      userContent: "问题含 </user_query> 字样",
      assistantContent: "最终回答",
    });
  });

  // Without turn_ended, an unfinished transcript must not publish as capture.
  it("rejects unfinished or body-less transcripts", () => {
    expect(extractTranscriptTurn(JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>\n问题\n</user_query>" }] },
    }))).toBeUndefined();
    expect(extractTranscriptTurn(JSON.stringify({
      type: "turn_ended",
      status: "success",
    }))).toBeUndefined();
  });

  // After the last seal, new-turn body must not republish the previous turn.
  it("rejects incomplete new turns after the last turn_ended", () => {
    const transcript = [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\n旧问题\n</user_query>" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "旧回答" }] },
      }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\n新问题\n</user_query>" }] },
      }),
    ].join("\n");

    expect(extractTranscriptTurn(transcript)).toBeUndefined();
  });

  // stop publishes the three transcript-derived events in one pending Buffer.
  it("publishes a complete pending once from transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-transcript-"));
    tempDirs.push(root);
    const projectsRoot = path.join(root, ".cursor", "projects");
    const transcriptDir = path.join(
      projectsRoot,
      "project",
      "agent-transcripts",
      "conversation",
    );
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "transcript.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "<user_query>\n问题\n</user_query>" }] },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "回答" }] },
        }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n"),
    );

    const file = await appendTranscriptTurn(
      root,
      projectsRoot,
      transcriptPath,
      "c1",
      "stop-gen",
      "completed",
      10,
    );

    expect(foldPending(await readFile(file, "utf8"))).toEqual({
      conversationId: "c1",
      userContent: "问题",
      assistantContent: "回答",
    });
  });

  // Hooks may only read bounded files under Cursor agent-transcripts.
  it("rejects non-transcript paths and oversized transcripts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-transcript-limit-"));
    tempDirs.push(root);
    const projectsRoot = path.join(root, ".cursor", "projects");
    await mkdir(projectsRoot, { recursive: true });
    const outside = path.join(root, "other.jsonl");
    await writeFile(outside, "{}");
    await expect(appendTranscriptTurn(
      root,
      projectsRoot,
      outside,
      "c1",
      "g1",
      "completed",
      1,
    )).rejects.toThrow(/transcript root/);

    const transcriptDir = path.join(
      projectsRoot,
      "project",
      "agent-transcripts",
    );
    await mkdir(transcriptDir, { recursive: true });
    const oversized = path.join(transcriptDir, "oversized.jsonl");
    await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(appendTranscriptTurn(
      root,
      projectsRoot,
      oversized,
      "c1",
      "g1",
      "completed",
      1,
    )).rejects.toThrow(/too large/);
  });

  // Symlinks under projects must not expand reads outside the root.
  it("rejects transcript symlinks that escape the projects root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-transcript-link-"));
    tempDirs.push(root);
    const projectsRoot = path.join(root, ".cursor", "projects");
    const transcriptDir = path.join(
      projectsRoot,
      "project",
      "agent-transcripts",
    );
    await mkdir(transcriptDir, { recursive: true });
    const outside = path.join(root, "outside.jsonl");
    await writeFile(outside, "{}");
    const linked = path.join(transcriptDir, "linked.jsonl");
    await symlink(outside, linked);

    await expect(appendTranscriptTurn(
      root,
      projectsRoot,
      linked,
      "c1",
      "g1",
      "completed",
      1,
    )).rejects.toThrow(/transcript root/);
  });
});
