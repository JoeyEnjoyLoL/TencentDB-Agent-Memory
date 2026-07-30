import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

interface PendingBase {
  v: 1;
  conversation_id: string;
  generation_id: string;
  at_ms: number;
}

export interface PendingUserEvent extends PendingBase {
  event: "user";
  text: string;
}

export interface PendingAssistantEvent extends PendingBase {
  event: "assistant";
  text: string;
}

export interface PendingStopEvent extends PendingBase {
  event: "stop";
  status: string;
}

export type PendingEvent =
  | PendingUserEvent
  | PendingAssistantEvent
  | PendingStopEvent;

export interface FoldedCapture {
  conversationId: string;
  userContent: string;
  assistantContent: string;
}

export function pendingKey(conversationId: string, generationId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([conversationId, generationId]), "utf8")
    .digest("hex");
}

export function pendingPath(
  rootDir: string,
  conversationId: string,
  generationId: string,
): string {
  return path.join(
    rootDir,
    "pending",
    `${pendingKey(conversationId, generationId)}.jsonl`,
  );
}

export async function appendPendingEvent(
  rootDir: string,
  event: PendingEvent,
): Promise<string> {
  const filePath = pendingPath(
    rootDir,
    event.conversation_id,
    event.generation_id,
  );
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  // 单个事件编码成一个 Buffer, 只执行一次 O_APPEND write.
  const line = Buffer.from(`\n${JSON.stringify(event)}\n`, "utf8");
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

function parseEvent(line: string): PendingEvent | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      value.v !== 1 ||
      typeof value.event !== "string" ||
      typeof value.conversation_id !== "string" ||
      typeof value.generation_id !== "string" ||
      typeof value.at_ms !== "number"
    ) {
      return undefined;
    }
    if (
      (value.event === "user" || value.event === "assistant") &&
      typeof value.text === "string"
    ) {
      return value as unknown as PendingUserEvent | PendingAssistantEvent;
    }
    if (value.event === "stop" && typeof value.status === "string") {
      return value as unknown as PendingStopEvent;
    }
  } catch {
    // 截断或损坏行只影响自己.
  }
  return undefined;
}

export function foldPending(content: string): FoldedCapture | undefined {
  let user: PendingUserEvent | undefined;
  const assistants: string[] = [];
  let stopped = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseEvent(line);
    if (!event || stopped) continue;

    if (event.event === "user") {
      if (!user && event.text.trim()) user = event;
      continue;
    }
    if (
      !user ||
      event.conversation_id !== user.conversation_id ||
      event.generation_id !== user.generation_id
    ) {
      continue;
    }
    if (event.event === "assistant") {
      if (event.text.trim()) assistants.push(event.text);
      continue;
    }
    if (event.event === "stop") stopped = true;
  }

  if (!user || !stopped || assistants.length === 0) return undefined;
  return {
    conversationId: user.conversation_id,
    userContent: user.text,
    assistantContent: assistants.join("\n\n"),
  };
}
