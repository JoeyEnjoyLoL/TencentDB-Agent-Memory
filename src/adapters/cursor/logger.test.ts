import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCursorLogger } from "./logger.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Cursor logger", () => {
  // 敏感字段即使误传也必须被遮蔽, 普通摘要保持有界.
  it("隐藏正文并限制字段长度", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "cursor-log-"));
    tempDirs.push(rootDir);
    const log = createCursorLogger(rootDir, { maxBytes: 10_000 });

    log("capture_error", {
      prompt: "敏感问题",
      assistant_content: "敏感回答",
      error: "x".repeat(1_000),
    });

    const raw = await readFile(
      path.join(rootDir, "logs", "cursor-hook.log"),
      "utf8",
    );
    expect(raw).not.toContain("敏感问题");
    expect(raw).not.toContain("敏感回答");
    expect(raw).toContain("[redacted]");
    expect(JSON.parse(raw).error.length).toBe(300);
  });
});
