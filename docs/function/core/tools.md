# Tools：主动检索

> **一句话**：Agent 在自动召回不够时，主动搜 L1 结构化记忆或 L0 原文。

出处：[`src/core/tools/memory-search.ts`](../../../src/core/tools/memory-search.ts)、[`conversation-search.ts`](../../../src/core/tools/conversation-search.ts)。索引：[INDEX.md](INDEX.md)。

---

## 总览

| 工具 | 搜什么 | 门面 |
|---|---|---|
| `tdai_memory_search` | L1 | `TdaiCore.searchMemories` |
| `tdai_conversation_search` | L0 | `TdaiCore.searchConversations` |

| 面 | 说明 |
|---|---|
| OpenClaw | `index.ts` 注册 |
| Gateway | `POST /search/memories`、`/search/conversations` |
| 频次 | 召回注入的 `<memory-tools-guide>`：两工具合计每轮最多 3 次（`auto-recall.ts`） |

---

## memory_search — I/O

| 输入 | 说明 |
|---|---|
| `query` | 必填 |
| `limit?` | 默认 5 |
| `type?` / `scene?` | 过滤 |

| 输出 | 说明 |
|---|---|
| `text` | 给模型的格式化文案 |
| `total` | 命中数 |
| `strategy` | `hybrid` / `embedding` / `fts` 等 |

降级顺序：hybrid（FTS+向量 RRF）→ 缺一路则单路 → 再继续降级。

---

## conversation_search — I/O

| 输入 | 说明 |
|---|---|
| `query` | 必填 |
| `limit?` | 默认 5 |
| `sessionKey?` | 限制会话 |

| 输出 | 说明 |
|---|---|
| `text` | 格式化原文片段 |
| `total` | 命中数 |

策略降级：hybrid（FTS5 + 向量 RRF）→ 仅 FTS 或仅 embedding → 皆不可用则 `strategy: "none"`、结果为空（可带 message）。

门面 `searchConversations` 对外只返回 `{ text, total }`（不回传 strategy）。

---

## 改哪里

| 目标 | 位置 |
|---|---|
| 排序 / RRF | `memory-search.ts` |
| 返回文案 | `formatSearchResponse` / conversation 对应 format |
| 注册与鉴权 | `index.ts`、`src/gateway/server.ts` |
| 底层检索 | [store.md](store.md) |
