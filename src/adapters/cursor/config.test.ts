import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCursorConfig } from "./config.js";

describe("resolveCursorConfig", () => {
  // 默认值必须与现有 Gateway 和数据目录约定一致.
  it("解析默认路径与 Gateway 地址", () => {
    const config = resolveCursorConfig({}, "/home/test", "/pkg", "/bin/cursor-memory");

    expect(config).toMatchObject({
      rootDir: "/home/test/.memory-tencentdb/cursor",
      dataDir: "/home/test/.memory-tencentdb/memory-tdai",
      gatewayUrl: "http://127.0.0.1:8420",
      captureTimeoutMs: 60_000,
      ctlPath: path.join("/pkg", "scripts", "memory-tencentdb-ctl.sh"),
      executablePath: "/bin/cursor-memory",
    });
  });

  // Adapter 专用变量优先, 鉴权密钥兼容 Gateway 变量.
  it("解析显式覆盖和鉴权回退", () => {
    const config = resolveCursorConfig({
      MEMORY_TENCENTDB_ROOT: "/memory",
      TDAI_DATA_DIR: "/data",
      MEMORY_TENCENTDB_GATEWAY_HOST: "localhost",
      MEMORY_TENCENTDB_GATEWAY_PORT: "9123",
      MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS: "70000",
      TDAI_GATEWAY_API_KEY: "secret",
    }, "/home/test", "/pkg", "/bin/cursor-memory");

    expect(config.rootDir).toBe("/memory/cursor");
    expect(config.dataDir).toBe("/data");
    expect(config.gatewayUrl).toBe("http://localhost:9123");
    expect(config.captureTimeoutMs).toBe(70_000);
    expect(config.gatewayApiKey).toBe("secret");
  });

  // 非法数值不能把 timeout 或端口污染为 NaN.
  it("非法数值回退默认值", () => {
    const config = resolveCursorConfig({
      MEMORY_TENCENTDB_GATEWAY_PORT: "bad",
      MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS: "-1",
    }, "/home/test", "/pkg", "/bin/cursor-memory");

    expect(config.gatewayUrl).toBe("http://127.0.0.1:8420");
    expect(config.captureTimeoutMs).toBe(60_000);
  });
});
