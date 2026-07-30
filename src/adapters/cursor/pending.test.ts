import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  // ID 不直接进入文件名, 避免路径穿越和长度问题.
  it("用规范 JSON 的 sha256 生成稳定文件名", () => {
    expect(pendingKey("../会话", "轮次/1")).toMatch(/^[0-9a-f]{64}$/);
    expect(pendingKey("../会话", "轮次/1")).toBe(pendingKey("../会话", "轮次/1"));
    expect(pendingKey("../会话", "轮次/2")).not.toBe(pendingKey("../会话", "轮次/1"));
  });

  // 每个 Hook 只追加一个带首尾换行的完整 Buffer.
  it("追加事件并保留首尾换行", async () => {
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

  // 截断和无效行不能遮蔽后续完整事件.
  it("跳过截断行并折叠首个完整轮次", () => {
    const folded = foldPending(`\n{"broken":\n\n${validTurn()}\n`);

    expect(folded).toEqual({
      conversationId: "c1",
      userContent: "问题",
      assistantContent: "回答一\n\n回答二",
    });
  });

  // 缺任一封口要素都不能投递.
  it("缺少 user assistant 或 stop 时保持不完整", () => {
    const lines = validTurn().split("\n");

    expect(foldPending(lines.slice(1).join("\n"))).toBeUndefined();
    expect(foldPending([lines[0], lines[3]].join("\n"))).toBeUndefined();
    expect(foldPending(lines.slice(0, 3).join("\n"))).toBeUndefined();
  });

  // 首个 stop 封口, 后续记录不能进入同一次 capture.
  it("忽略重复 user stop 和 stop 后记录", () => {
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

  // stop transcript 只还原最后一个 turn_ended 前的当前轮次.
  it("从 transcript 无歧义提取最后一轮 user 和最终 assistant", () => {
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

  // 未出现 turn_ended 时不能把尚未完成的 transcript 发布为 capture.
  it("拒绝未结束或缺正文的 transcript", () => {
    expect(extractTranscriptTurn(JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>\n问题\n</user_query>" }] },
    }))).toBeUndefined();
    expect(extractTranscriptTurn(JSON.stringify({
      type: "turn_ended",
      status: "success",
    }))).toBeUndefined();
  });

  // 最后封口后若已有新轮次正文, 不能重复发布上一轮.
  it("拒绝最后 turn_ended 后的未完成新轮次", () => {
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

  // stop 用一个 pending Buffer 发布 transcript 还原出的三条事件.
  it("从 transcript 单次发布完整 pending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-transcript-"));
    tempDirs.push(root);
    const transcriptDir = path.join(root, "agent-transcripts", "conversation");
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

  // Hook 只能读取 Cursor agent-transcripts 下的有界文件.
  it("拒绝非 transcript 路径和超大 transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-transcript-limit-"));
    tempDirs.push(root);
    const outside = path.join(root, "other.jsonl");
    await writeFile(outside, "{}");
    await expect(appendTranscriptTurn(
      root,
      outside,
      "c1",
      "g1",
      "completed",
      1,
    )).rejects.toThrow(/agent-transcripts/);

    const transcriptDir = path.join(root, "agent-transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const oversized = path.join(transcriptDir, "oversized.jsonl");
    await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(appendTranscriptTurn(
      root,
      oversized,
      "c1",
      "g1",
      "completed",
      1,
    )).rejects.toThrow(/too large/);
  });
});
