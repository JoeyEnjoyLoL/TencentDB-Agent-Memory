import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendPendingEvent,
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
});
