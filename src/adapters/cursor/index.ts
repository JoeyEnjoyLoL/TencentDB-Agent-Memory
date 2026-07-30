/**
 * Cursor adapter — barrel exports for the host-side integration surface.
 *
 * Re-exports install/MCP/hook/worker entry points used by the CLI binary.
 * Keeps Cursor-specific wiring discoverable without pulling Gateway or Core.
 */

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
