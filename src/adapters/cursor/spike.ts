import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";

export async function recordSpikeEvent(
  payload: Record<string, unknown>,
  outputDir: string,
  now: () => number = Date.now,
): Promise<string> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const transcriptPath =
    typeof payload.transcript_path === "string"
      ? payload.transcript_path
      : undefined;
  const transcriptInfo = transcriptPath
    ? await stat(transcriptPath).catch(() => undefined)
    : undefined;

  // 只留运行时形态证据, 不复制 prompt response 或 transcript 正文.
  const evidence = {
    at_ms: now(),
    hook_event_name: payload.hook_event_name,
    conversation_id: payload.conversation_id,
    generation_id: payload.generation_id,
    parent_conversation_id: payload.parent_conversation_id,
    is_background_agent: payload.is_background_agent,
    cursor_version: payload.cursor_version,
    status: payload.status,
    reason: payload.reason,
    prompt_length:
      typeof payload.prompt === "string" ? payload.prompt.length : undefined,
    text_length:
      typeof payload.text === "string" ? payload.text.length : undefined,
    transcript_path_hash: transcriptPath
      ? createHash("sha256").update(transcriptPath, "utf8").digest("hex")
      : undefined,
    transcript_exists: Boolean(transcriptInfo),
    transcript_size: transcriptInfo?.size,
    input_keys: Object.keys(payload).sort(),
  };
  const line = Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8");
  const filePath = path.join(outputDir, "hook-events.jsonl");
  const handle = await open(
    filePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600,
  );
  try {
    const result = await handle.write(line, 0, line.length, null);
    if (result.bytesWritten !== line.length) {
      throw new Error(
        `short append: wrote ${result.bytesWritten} of ${line.length} bytes`,
      );
    }
  } finally {
    await handle.close();
  }
  return filePath;
}
