/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/      — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   ├── standalone/    — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   └── cursor/        — Cursor IDE host (Hooks / MCP → Gateway HTTP)
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Cursor IDE adapter (Gateway HTTP; see src/adapters/cursor/README.md)
export {
  resolveCursorConfig,
  CURSOR_ADAPTER_MARKER,
  installCursorAdapter,
  uninstallCursorAdapter,
  createCursorMcpServer,
  handleHook,
  runWorker,
} from "./cursor/index.js";
export type { CursorConfig } from "./cursor/index.js";
