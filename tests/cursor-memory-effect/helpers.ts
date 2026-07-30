import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CursorConfig } from "../../src/adapters/cursor/config.js";
import { handleHook } from "../../src/adapters/cursor/hooks.js";
import { runWorker } from "../../src/adapters/cursor/worker.js";
import type { GatewayResult } from "../../src/adapters/cursor/gateway.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 固定沙箱根；每次 reset 可清空。开发机数据随时重置时用这个目录，不碰真实 ~/.memory-tencentdb。 */
export const SANDBOX_ROOT = path.join(
  repoRoot,
  "tests",
  "cursor-memory-effect",
  ".sandbox",
);

export const PERSONA_MARKER = "VERIFY-PERSONA-MARKER";
export const SCENE_FILENAME = "memory-effect-scene.md";

export interface MemoryEffectSandbox {
  root: string;
  dataDir: string;
  cursorRoot: string;
  transcriptsRoot: string;
  projectsRoot: string;
  config: CursorConfig;
  token: string;
  rememberPrompt: string;
  askPrompt: string;
}

export function makeToken(prefix = "MEMFX"): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

export async function resetSandbox(token = makeToken()): Promise<MemoryEffectSandbox> {
  await rm(SANDBOX_ROOT, { recursive: true, force: true });
  await mkdir(SANDBOX_ROOT, { recursive: true, mode: 0o700 });

  const dataDir = path.join(SANDBOX_ROOT, "memory-tdai");
  const cursorRoot = path.join(SANDBOX_ROOT, "cursor");
  const projectsRoot = path.join(SANDBOX_ROOT, ".cursor", "projects");
  const transcriptsRoot = projectsRoot;

  await mkdir(path.join(dataDir, ".metadata"), { recursive: true });
  await mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  await mkdir(path.join(cursorRoot, "pending"), { recursive: true });
  await mkdir(path.join(cursorRoot, "logs"), { recursive: true });
  await mkdir(path.join(cursorRoot, "sessions"), { recursive: true });
  await mkdir(projectsRoot, { recursive: true });

  const rememberPrompt =
    `请记住：我的构建口令是 ${token}。只要确认即可，不要展开。`;
  const askPrompt = "我的构建口令是什么？只答口令本身。";

  await writeFile(
    path.join(dataDir, "persona.md"),
    `${PERSONA_MARKER}\n验证用极简偏好；构建口令以会话记忆为准。\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(dataDir, "scene_blocks", SCENE_FILENAME),
    [
      "-----META-START-----",
      `summary: 用户构建口令是 ${token}`,
      "heat: 1",
      "-----META-END-----",
      "",
      `用户的构建口令是 **${token}**。`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(dataDir, ".metadata", "scene_index.json"),
    `${JSON.stringify([
      {
        filename: SCENE_FILENAME,
        summary: `用户构建口令是 ${token}`,
        heat: 1,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
    ], null, 2)}\n`,
    { mode: 0o600 },
  );

  const config: CursorConfig = {
    rootDir: cursorRoot,
    dataDir,
    gatewayUrl: "http://127.0.0.1:8420",
    captureTimeoutMs: 60_000,
    ctlPath: path.join(repoRoot, "scripts", "memory-tencentdb-ctl.sh"),
    executablePath: path.join(repoRoot, "bin", "memory-tencentdb-cursor.mjs"),
    transcriptsRoot,
  };

  return {
    root: SANDBOX_ROOT,
    dataDir,
    cursorRoot,
    transcriptsRoot,
    projectsRoot,
    config,
    token,
    rememberPrompt,
    askPrompt,
  };
}

/** 临时沙箱（跑完可删），适合并行；与固定 SANDBOX_ROOT 二选一。 */
export async function createTempSandbox(
  token = makeToken(),
): Promise<MemoryEffectSandbox & { dispose: () => Promise<void> }> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "memfx-"));
  const dataDir = path.join(tempRoot, "memory-tdai");
  const cursorRoot = path.join(tempRoot, "cursor");
  const projectsRoot = path.join(tempRoot, ".cursor", "projects");
  await mkdir(path.join(dataDir, ".metadata"), { recursive: true });
  await mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  await mkdir(path.join(cursorRoot, "pending"), { recursive: true });
  await mkdir(path.join(cursorRoot, "logs"), { recursive: true });
  await mkdir(path.join(cursorRoot, "sessions"), { recursive: true });
  await mkdir(projectsRoot, { recursive: true });

  const rememberPrompt =
    `请记住：我的构建口令是 ${token}。只要确认即可，不要展开。`;
  const askPrompt = "我的构建口令是什么？只答口令本身。";

  await writeFile(
    path.join(dataDir, "persona.md"),
    `${PERSONA_MARKER}\n验证用极简偏好；构建口令以会话记忆为准。\n`,
  );
  await writeFile(
    path.join(dataDir, "scene_blocks", SCENE_FILENAME),
    `用户的构建口令是 **${token}**。\n`,
  );
  await writeFile(
    path.join(dataDir, ".metadata", "scene_index.json"),
    JSON.stringify([
      {
        filename: SCENE_FILENAME,
        summary: `用户构建口令是 ${token}`,
        heat: 1,
        created: "",
        updated: "",
      },
    ]),
  );

  const config: CursorConfig = {
    rootDir: cursorRoot,
    dataDir,
    gatewayUrl: "http://127.0.0.1:8420",
    captureTimeoutMs: 60_000,
    ctlPath: path.join(repoRoot, "scripts", "memory-tencentdb-ctl.sh"),
    executablePath: path.join(repoRoot, "bin", "memory-tencentdb-cursor.mjs"),
    transcriptsRoot: projectsRoot,
  };

  return {
    root: tempRoot,
    dataDir,
    cursorRoot,
    transcriptsRoot: projectsRoot,
    projectsRoot,
    config,
    token,
    rememberPrompt,
    askPrompt,
    dispose: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function writeClosedTranscript(options: {
  projectsRoot: string;
  conversationId: string;
  userText: string;
  assistantText: string;
}): Promise<string> {
  const transcriptDir = path.join(
    options.projectsRoot,
    "memory-effect",
    "agent-transcripts",
    options.conversationId,
  );
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(
    transcriptDir,
    `${options.conversationId}.jsonl`,
  );
  const body = [
    JSON.stringify({
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: `<user_query>\n${options.userText}\n</user_query>`,
          },
        ],
      },
    }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [{ type: "text", text: options.assistantText }],
      },
    }),
    JSON.stringify({ type: "turn_ended", status: "success" }),
  ].join("\n");
  await writeFile(transcriptPath, `${body}\n`);
  return transcriptPath;
}

export async function listPendingFiles(cursorRoot: string): Promise<string[]> {
  try {
    return (await readdir(path.join(cursorRoot, "pending")))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

export async function readPendingBodies(cursorRoot: string): Promise<string[]> {
  const names = await listPendingFiles(cursorRoot);
  return Promise.all(
    names.map((name) =>
      readFile(path.join(cursorRoot, "pending", name), "utf8"),
    ),
  );
}

export interface HookRunLog {
  event: string;
  fields?: Record<string, unknown>;
}

export async function runSessionStart(
  sandbox: MemoryEffectSandbox,
  conversationId: string,
  log: HookRunLog[] = [],
): Promise<Record<string, unknown>> {
  return handleHook(
    {
      hook_event_name: "sessionStart",
      conversation_id: conversationId,
      is_background_agent: false,
    },
    {
      dataDir: sandbox.dataDir,
      rootDir: sandbox.cursorRoot,
      transcriptsRoot: sandbox.transcriptsRoot,
      spawnWorker: () => undefined,
      log: (event, fields) => {
        log.push({ event, fields });
      },
    },
  );
}

export async function runStopCapture(
  sandbox: MemoryEffectSandbox,
  options: {
    conversationId: string;
    generationId: string;
    transcriptPath: string;
    status?: string;
  },
  log: HookRunLog[] = [],
  spawned: { count: number } = { count: 0 },
): Promise<Record<string, unknown>> {
  return handleHook(
    {
      hook_event_name: "stop",
      conversation_id: options.conversationId,
      generation_id: options.generationId,
      transcript_path: options.transcriptPath,
      status: options.status ?? "completed",
    },
    {
      dataDir: sandbox.dataDir,
      rootDir: sandbox.cursorRoot,
      transcriptsRoot: sandbox.transcriptsRoot,
      spawnWorker: () => {
        spawned.count += 1;
      },
      log: (event, fields) => {
        log.push({ event, fields });
      },
    },
  );
}

export async function drainWorkerWithMockCapture(
  sandbox: MemoryEffectSandbox,
  captures: Array<Record<string, unknown>>,
  log: HookRunLog[] = [],
): Promise<void> {
  await runWorker({
    config: sandbox.config,
    startGateway: async () => true,
    request: async (route, body) => {
      if (route === "/capture") {
        captures.push(body as Record<string, unknown>);
        return { status: 200, body: JSON.stringify({ l0_recorded: 2 }) };
      }
      return { status: 200, body: "{}" };
    },
    log: (event, fields) => {
      log.push({ event, fields });
    },
  });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 轻量假 Gateway：只实现 /health 与 /capture，供不启真实 Gateway 的联调。 */
export async function startFakeGateway(options?: {
  port?: number;
  onCapture?: (body: unknown) => void;
}): Promise<{
  url: string;
  captures: unknown[];
  close: () => Promise<void>;
}> {
  const captures: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/capture") {
      const raw = await readRequestBody(req);
      const body = raw ? JSON.parse(raw) : {};
      captures.push(body);
      options?.onCapture?.(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ l0_recorded: 2, scheduler_notified: false }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/search/conversations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: "No matching conversation messages found.", total: 0 }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/search/memories") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: "No matching memories found.", total: 0, strategy: "none" }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const port = options?.port ?? 0;
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake gateway failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    captures,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function liveGatewayBaseUrl(): Promise<string | undefined> {
  const base =
    process.env.MEMORY_EFFECT_GATEWAY_URL ??
    process.env.MEMORY_TENCENTDB_GATEWAY_URL ??
    "http://127.0.0.1:8420";
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    return base;
  } catch {
    return undefined;
  }
}

export function liveEnabled(): boolean {
  return process.env.MEMORY_EFFECT_LIVE === "1";
}

export async function postJson(
  baseUrl: string,
  route: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // keep raw text
  }
  return { status: response.status, json };
}

export async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const intervalMs = options?.intervalMs ?? 500;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

export type { GatewayResult };
