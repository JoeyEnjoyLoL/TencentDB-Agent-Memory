# Core 边界类型（types）

> **一句话**：Core 只认这套类型：谁提供环境、怎么调 LLM、一轮长什么样、结果长什么样。

出处：[`src/core/types.ts`](../../../src/core/types.ts)。索引：[INDEX.md](INDEX.md)。

---

## 职责

| 做 | 不做 |
|---|---|
| 定义 `HostAdapter` / `LLMRunner` / turn / 结果类型 | 实现具体宿主或 HTTP |
| 保证 Core 只依赖本文件接口 | 引用 OpenClaw / Hermes SDK |

原则（代码头注释）：Core **只**依赖这些接口；每个宿主自带 `HostAdapter` + `LLMRunnerFactory`。

---

## I/O 契约

### HostAdapter

| 方法 | 输出 |
|---|---|
| `hostType` | `"openclaw" \| "hermes" \| "standalone"` |
| `getRuntimeContext()` | `RuntimeContext`（含 `dataDir`、`sessionKey`、`userId`…） |
| `getLogger()` | `Logger` |
| `getLLMRunnerFactory()` | `LLMRunnerFactory` |

实现：`src/adapters/openclaw/host-adapter.ts`、`src/adapters/standalone/`。

### LLMRunner

| 输入（`LLMRunParams`） | 输出 |
|---|---|
| `prompt`、可选 `systemPrompt`、`taskId`、超时/token、workspace | `Promise<string>` 文本 |

| `enableTools` | 用途 |
|---|---|
| `false` | L1 抽取 / 去重 |
| `true` | L2 场景 / L3 画像（可写文件工具） |

### CompletedTurn → Capture

| 字段 | 用途 |
|---|---|
| `userText` / `assistantText` / `messages` | 本轮内容 |
| `sessionKey` / `sessionId?` | 分组 |
| `startedAt?` | 冷启动游标兜底 |
| `originalUserMessageCount?` | L0 定位被 prepend 污染的 user 消息 |

### 结果类型

| 类型 | 关键字段 |
|---|---|
| `RecallResult` | `prependContext?`、`appendSystemContext?`、指标字段 |
| `CaptureResult` | `l0RecordedCount`、`schedulerNotified`、`l0VectorsWritten`、`filteredMessages` |
| `MemorySearchParams` | `query`、`limit?`、`type?`、`scene?` |
| `ConversationSearchParams` | `query`、`limit?`、`sessionKey?` |

---

## 注意

`TdaiCore.handleBeforeRecall` 当前把 `actorId` 写死为 `"default_user"`（见 `tdai-core.ts`）。v1 隔离主要靠 `dataDir`，见 [docs/spec.md](../../spec.md)。

---

## 改哪里

| 目标 | 位置 |
|---|---|
| 扩 RuntimeContext / 结果字段 | `types.ts` + 所有调用方 |
| 新宿主适配 | 实现 `HostAdapter`，勿改 Core 算法 |
| 门面用法 | [tdai-core.md](tdai-core.md) |
