export { resolveCursorConfig } from "./config.js";
export type { CursorConfig } from "./config.js";
export {
  CURSOR_ADAPTER_MARKER,
  installCursorAdapter,
  uninstallCursorAdapter,
} from "./installer.js";
export { createCursorMcpServer } from "./mcp.js";
export { handleHook } from "./hooks.js";
export { runWorker } from "./worker.js";
