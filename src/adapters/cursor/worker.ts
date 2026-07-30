import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import type { CursorConfig } from "./config.js";
import type {
  CaptureRequest,
  SessionEndRequest,
} from "../../gateway/types.js";
import { gatewayRequest, type GatewayResult } from "./gateway.js";
import { foldPending, type FoldedCapture } from "./pending.js";

const execFileAsync = promisify(execFile);
const INCOMPLETE_TTL_MS = 24 * 60 * 60 * 1_000;

interface LockOptions {
  realpath: false;
  stale: number;
  update: number;
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
  };
  onCompromised: (error: Error) => void;
}

type ReleaseLock = () => Promise<void> | void;

export interface WorkerOptions {
  config: CursorConfig;
  sessionEndKey?: string;
  acquireLock?: (
    target: string,
    options: LockOptions,
  ) => Promise<ReleaseLock>;
  startGateway?: () => Promise<boolean>;
  request?: (route: string, body: unknown) => Promise<GatewayResult>;
  remove?: (filePath: string) => Promise<void>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

interface PendingFile {
  path: string;
  capture?: FoldedCapture;
  mtimeMs: number;
}

async function listPending(rootDir: string): Promise<PendingFile[]> {
  const dir = path.join(rootDir, "pending");
  let names: string[];
  try {
    names = (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }

  const result: PendingFile[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const [content, info] = await Promise.all([
        readFile(filePath, "utf8"),
        stat(filePath),
      ]);
      result.push({
        path: filePath,
        capture: foldPending(content),
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // Hook 可能正创建文件, 下次扫描会再次处理.
    }
  }
  return result;
}

async function defaultStartGateway(config: CursorConfig): Promise<boolean> {
  try {
    await execFileAsync(config.ctlPath, ["start"], {
      timeout: 30_000,
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

function isSuccess(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}

function isPermanent(status: number | undefined): boolean {
  return status === 400 || status === 413 || status === 415 || status === 422;
}

function boundedError(error: unknown): { error: string } {
  return {
    error: error instanceof Error
      ? error.message.slice(0, 300)
      : String(error).slice(0, 300),
  };
}

export async function runWorker(options: WorkerOptions): Promise<void> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const request =
    options.request ??
    ((route: string, body: unknown) => gatewayRequest(route, body, config));
  const startGateway =
    options.startGateway ?? (() => defaultStartGateway(config));
  const remove = options.remove ?? unlink;
  const acquireLock =
    options.acquireLock ??
    ((target: string, lockOptions: LockOptions) =>
      lockfile.lock(target, lockOptions));

  await mkdir(config.rootDir, { recursive: true, mode: 0o700 });
  let compromised = false;
  let release: ReleaseLock;
  try {
    release = await acquireLock(config.rootDir, {
      realpath: false,
      stale: 180_000,
      update: 10_000,
      retries: {
        retries: 120,
        factor: 1,
        minTimeout: 1_000,
        maxTimeout: 1_000,
      },
      onCompromised: (error) => {
        compromised = true;
        options.log("lock_compromised", {
          error: error.message.slice(0, 300),
        });
      },
    });
  } catch (error) {
    options.log("lock_acquire_failed", boundedError(error));
    return;
  }

  try {
    const initial = await listPending(config.rootDir);
    for (const pending of initial) {
      if (
        !pending.capture &&
        now() - pending.mtimeMs > INCOMPLETE_TTL_MS
      ) {
        try {
          await remove(pending.path);
          options.log("incomplete_expired", {
            pending: path.basename(pending.path, ".jsonl"),
          });
        } catch (error) {
          options.log("pending_delete_failed", {
            pending: path.basename(pending.path, ".jsonl"),
            ...boundedError(error),
          });
        }
      }
    }

    if (
      compromised ||
      (!initial.some((item) => item.capture) && !options.sessionEndKey)
    ) {
      return;
    }

    if (!(await startGateway())) {
      options.log("gateway_start_failed");
      return;
    }

    let retained = false;
    while (!compromised && !retained) {
      // Gateway 启动和上一批投递期间可能有新 Hook 完成, 持锁重扫到静止.
      const pendingFiles = await listPending(config.rootDir);
      const complete = pendingFiles.filter((pending) => pending.capture);
      if (complete.length === 0) break;

      for (const pending of complete) {
        if (compromised || !pending.capture) return;

        const captureRequest: CaptureRequest = {
          user_content: pending.capture.userContent,
          assistant_content: pending.capture.assistantContent,
          session_key: `cursor:${pending.capture.conversationId}`,
        };
        const result = await request("/capture", captureRequest);

        if (compromised) return;
        const pendingName = path.basename(pending.path, ".jsonl");
        if (isSuccess(result.status) || isPermanent(result.status)) {
          try {
            await remove(pending.path);
          } catch (error) {
            options.log("pending_delete_failed", {
              pending: pendingName,
              ...boundedError(error),
            });
            retained = true;
            break;
          }
          options.log(
            isSuccess(result.status)
              ? "capture_acked"
              : "capture_permanent_error",
            {
              pending: pendingName,
              status: result.status,
            },
          );
          continue;
        }

        options.log("capture_retained", {
          pending: pendingName,
          status: result.status,
          error: result.error,
        });
        retained = true;
        break;
      }
    }

    if (options.sessionEndKey && !compromised) {
      const sessionEndRequest: SessionEndRequest = {
        session_key: options.sessionEndKey,
      };
      const result = await request("/session/end", sessionEndRequest);
      options.log("session_end", {
        status: result.status,
        error: result.error,
      });
    }
  } finally {
    try {
      await release();
    } catch (error) {
      options.log("lock_release_error", boundedError(error));
    }
  }
}
