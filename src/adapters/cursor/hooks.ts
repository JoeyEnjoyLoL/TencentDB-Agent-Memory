import { appendPendingEvent, type PendingEvent } from "./pending.js";
import { buildSessionContext } from "./context.js";

export type HookPayload = Record<string, unknown>;

export interface HookDependencies {
  dataDir: string;
  rootDir: string;
  append?: (rootDir: string, event: PendingEvent) => Promise<string>;
  spawnWorker: (sessionEndKey?: string) => void;
  buildContext?: (dataDir: string) => Promise<string | undefined>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTopLevelInteractive(payload: HookPayload): boolean {
  if (payload.is_background_agent === true) return false;
  if (text(payload.parent_conversation_id)) return false;
  return true;
}

function failOpenResponse(event: string | undefined): Record<string, unknown> {
  return event === "beforeSubmitPrompt" ? { continue: true } : {};
}

export async function handleHook(
  payload: HookPayload,
  deps: HookDependencies,
): Promise<Record<string, unknown>> {
  const event = text(payload.hook_event_name);
  const response = failOpenResponse(event);

  if (!isTopLevelInteractive(payload)) return response;

  const append = deps.append ?? appendPendingEvent;
  const contextBuilder = deps.buildContext ?? buildSessionContext;
  const now = deps.now ?? Date.now;

  try {
    if (event === "sessionStart") {
      const context = await contextBuilder(deps.dataDir);
      return context ? { additional_context: context } : {};
    }

    const conversationId =
      text(payload.conversation_id) ?? text(payload.session_id);
    if (event === "sessionEnd") {
      deps.spawnWorker(conversationId ? `cursor:${conversationId}` : undefined);
      return {};
    }

    const generationId = text(payload.generation_id);
    if (!conversationId || !generationId) return response;

    if (event === "beforeSubmitPrompt") {
      const prompt = text(payload.prompt);
      if (prompt) {
        await append(deps.rootDir, {
          v: 1,
          event: "user",
          conversation_id: conversationId,
          generation_id: generationId,
          text: prompt,
          at_ms: now(),
        });
      }
      return { continue: true };
    }

    if (event === "afterAgentResponse") {
      const assistant = text(payload.text);
      if (assistant) {
        await append(deps.rootDir, {
          v: 1,
          event: "assistant",
          conversation_id: conversationId,
          generation_id: generationId,
          text: assistant,
          at_ms: now(),
        });
      }
      return {};
    }

    if (event === "stop") {
      await append(deps.rootDir, {
        v: 1,
        event: "stop",
        conversation_id: conversationId,
        generation_id: generationId,
        status: text(payload.status) ?? "completed",
        at_ms: now(),
      });
      deps.spawnWorker();
      return {};
    }
  } catch (error) {
    deps.log("hook_error", {
      event,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
  }

  return response;
}
