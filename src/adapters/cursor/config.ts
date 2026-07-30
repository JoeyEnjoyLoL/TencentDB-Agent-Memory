import path from "node:path";

export interface CursorConfig {
  rootDir: string;
  dataDir: string;
  gatewayUrl: string;
  gatewayApiKey?: string;
  captureTimeoutMs: number;
  ctlPath: string;
  executablePath: string;
}

type Env = Record<string, string | undefined>;

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCursorConfig(
  env: Env = process.env,
  home = env.HOME ?? env.USERPROFILE ?? "/tmp",
  packageRoot = process.cwd(),
  executablePath = process.argv[1] ?? "memory-tencentdb-cursor",
): CursorConfig {
  const memoryRoot = env.MEMORY_TENCENTDB_ROOT ?? path.join(home, ".memory-tencentdb");
  const host = env.MEMORY_TENCENTDB_GATEWAY_HOST ?? "127.0.0.1";
  const port = positiveInt(env.MEMORY_TENCENTDB_GATEWAY_PORT, 8420);

  return {
    rootDir: env.MEMORY_TENCENTDB_CURSOR_ROOT ?? path.join(memoryRoot, "cursor"),
    dataDir: env.TDAI_DATA_DIR ?? path.join(memoryRoot, "memory-tdai"),
    gatewayUrl: `http://${host}:${port}`,
    gatewayApiKey:
      env.MEMORY_TENCENTDB_GATEWAY_API_KEY ??
      env.TDAI_GATEWAY_API_KEY ??
      undefined,
    captureTimeoutMs: positiveInt(
      env.MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS,
      60_000,
    ),
    ctlPath:
      env.MEMORY_TENCENTDB_CTL_PATH ??
      path.join(packageRoot, "scripts", "memory-tencentdb-ctl.sh"),
    executablePath,
  };
}
