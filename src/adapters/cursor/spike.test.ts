import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordSpikeEvent } from "./spike.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Cursor Hook spike recorder", () => {
  // spike 只留关联与形态证据, 不复制 prompt 或 response 正文.
  it("记录元数据并隐藏正文", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "cursor-spike-"));
    tempDirs.push(outputDir);

    const file = await recordSpikeEvent({
      hook_event_name: "afterAgentResponse",
      conversation_id: "c1",
      generation_id: "g1",
      parent_conversation_id: "parent",
      is_background_agent: false,
      text: "敏感回答正文",
      transcript_path: "/missing/transcript.jsonl",
    }, outputDir, () => 123);

    const raw = await readFile(file, "utf8");
    const event = JSON.parse(raw.trim());
    expect(event).toMatchObject({
      at_ms: 123,
      hook_event_name: "afterAgentResponse",
      conversation_id: "c1",
      generation_id: "g1",
      parent_conversation_id: "parent",
      is_background_agent: false,
      text_length: 6,
      transcript_exists: false,
    });
    expect(raw).not.toContain("敏感回答正文");
  });
});
