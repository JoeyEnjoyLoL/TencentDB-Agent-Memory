import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCursorConfig } from "./config.js";

describe("resolveCursorConfig", () => {
  // Defaults must match existing Gateway and data-dir conventions.
  it("resolves default paths and Gateway address", () => {
    const config = resolveCursorConfig({}, "/home/test", "/pkg", "/bin/cursor-memory");

    expect(config).toMatchObject({
      rootDir: "/home/test/.memory-tencentdb/cursor",
      dataDir: "/home/test/.memory-tencentdb/memory-tdai",
      gatewayUrl: "http://127.0.0.1:8420",
      captureTimeoutMs: 60_000,
      ctlPath: path.join("/pkg", "scripts", "memory-tencentdb-ctl.sh"),
      executablePath: "/bin/cursor-memory",
      transcriptsRoot: "/home/test/.cursor/projects",
    });
  });

  // Adapter-specific vars win; auth key falls back to Gateway vars.
  it("resolves explicit overrides and auth fallback", () => {
    const config = resolveCursorConfig({
      MEMORY_TENCENTDB_ROOT: "/memory",
      TDAI_DATA_DIR: "/data",
      MEMORY_TENCENTDB_GATEWAY_HOST: "localhost",
      MEMORY_TENCENTDB_GATEWAY_PORT: "9123",
      MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS: "70000",
      MEMORY_TENCENTDB_CURSOR_TRANSCRIPTS_ROOT: "/cursor-projects",
      TDAI_GATEWAY_API_KEY: "secret",
    }, "/home/test", "/pkg", "/bin/cursor-memory");

    expect(config.rootDir).toBe("/memory/cursor");
    expect(config.dataDir).toBe("/data");
    expect(config.gatewayUrl).toBe("http://localhost:9123");
    expect(config.captureTimeoutMs).toBe(70_000);
    expect(config.gatewayApiKey).toBe("secret");
    expect(config.transcriptsRoot).toBe("/cursor-projects");
  });

  // Invalid numbers must not pollute timeout or port into NaN.
  it("falls back to defaults for invalid numbers", () => {
    const config = resolveCursorConfig({
      MEMORY_TENCENTDB_GATEWAY_PORT: "bad",
      MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS: "-1",
    }, "/home/test", "/pkg", "/bin/cursor-memory");

    expect(config.gatewayUrl).toBe("http://127.0.0.1:8420");
    expect(config.captureTimeoutMs).toBe(60_000);
  });
});
