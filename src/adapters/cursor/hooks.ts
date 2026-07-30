import { appendTranscriptTurn } from "./pending.js";
import { buildSessionContext } from "./context.js";

export type HookPayload = Record<string, unknown>;

export interface HookDependencies {
  dataDir: string;
  rootDir: string;
  appendTranscript?: typeof appendTranscriptTurn;
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

  const appendTranscript = deps.appendTranscript ?? appendTranscriptTurn;
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

    if (event === "beforeSubmitPrompt") {
      return { continue: true };
    }

    if (event === "afterAgentResponse") {
      return {};
    }

    if (event === "stop") {
      try {
        if (!conversationId) throw new Error("stop conversation_id is missing");
        const generationId = text(payload.generation_id);
        if (!generationId) throw new Error("stop generation_id is missing");
        const transcriptPath = text(payload.transcript_path);
        if (!transcriptPath) throw new Error("stop transcript_path is missing");
        await appendTranscript(
          deps.rootDir,
          transcriptPath,
          conversationId,
          generationId,
          text(payload.status) ?? "completed",
          now(),
        );
      } catch (error) {
        deps.log("stop_capture_error", {
          error: error instanceof Error
            ? error.message.slice(0, 300)
            : String(error).slice(0, 300),
        });
      }
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
