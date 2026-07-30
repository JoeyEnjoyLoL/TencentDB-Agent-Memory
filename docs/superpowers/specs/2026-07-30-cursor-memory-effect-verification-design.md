# Cursor Adapter 记忆效果验证设计

日期：2026-07-30  
范围：本机 Linux / 当前 checkout / Cursor IDE  
依据：[docs/316base/spec.md](../../316base/spec.md)

## 目标

分两阶段验证 Cursor Adapter 的记忆效果：

1. **链路通**：一轮对话后 pending → one-shot → Gateway `/capture` 成功，可在 L0/日志中核对。
2. **体验通**：新开会话可见 `sessionStart` 注入或主动调用只读 MCP，并据此答对埋入的标记事实。

不修改 Gateway / TdaiCore；不修 reviewer01 的 P0（验证过程若触发丢/重记，记入结果笔记）。

## 方案选择

采用方案 A：

| 项 | 选择 |
| --- | --- |
| Gateway 源码 | 当前仓库 checkout，symlink/复制到 `$TDAI_INSTALL_DIR` |
| Gateway 模式 | standalone（不改 hermes `memory.provider`） |
| Cursor Adapter 作用域 | `project`（本仓 `.cursor/`） |
| LLM | DeepSeek：`https://api.deepseek.com` / `deepseek-v4-pro`（密钥仅写入本机 `tdai-gateway.json`，0600） |
| Embedding | `--provider none`（BM25/关键词；DeepSeek 无兼容 embedding） |
| Spike | 验证前卸除 spike Hook，避免与生产 Adapter 双跑 |

备选 B（npm latest + user 作用域）与 C（仅 curl 假 capture）不采用。

## 架构与数据流

```text
会话1 stop
  → transcript 最后一轮
  → pending JSONL
  → detached one-shot + global lock
  → POST /capture
  → L0（及后续抽取，依赖 LLM）

会话2 sessionStart
  → persona.md + scene_index + tool guide → additional_context

会话2 问答
  → Rule / 注入提示 → tdai_memory_search / tdai_conversation_search
  → 模型引用命中内容回答
```

路径约定（均可被环境变量覆盖）：

| 变量 | 默认 |
| --- | --- |
| `MEMORY_TENCENTDB_ROOT` | `~/.memory-tencentdb` |
| `TDAI_INSTALL_DIR` | `$ROOT/tdai-memory-openclaw-plugin` |
| `TDAI_DATA_DIR` | `$ROOT/memory-tdai` |
| `MEMORY_TENCENTDB_CURSOR_ROOT` | `$ROOT/cursor` |
| Gateway | `127.0.0.1:8420` |

## 阶段 0 — 准备

1. 确认 Node ≥ 22；在本仓 `npm install`（若缺依赖）。
2. 将本仓作为 Gateway 安装源挂到 `TDAI_INSTALL_DIR`（symlink 或受控复制），保证 `src/gateway/server.ts` 与 `node_modules`/`tsx` 可用。
3. `memory-tencentdb-ctl.sh config llm`（DeepSeek）+ `config embedding --provider none`。
4. `memory-tencentdb-ctl.sh start`，`GET /health` 通过。
5. 写入可辨认探针 `persona.md`（例如含固定标签 `VERIFY-PERSONA-MARKER`），便于会话2首轮可见性核对。
6. 卸除本仓 spike Hook（若仍注册）；`memory-tencentdb-cursor install --scope project`。
7. 核对 `.cursor/hooks.json`、`.cursor/mcp.json`、`.cursor/rules/tencentdb-memory.mdc` 含固定标识，且用户级无同标识冲突。

## 阶段 1 — 链路验证（同一会话）

埋入口令（固定字符串，便于搜）：

```text
请记住：我的构建口令是 BLUE-TIGER-42。只要确认即可，不要展开。
```

成功判据（全部满足才算链路通）：

| 检查 | 判据 |
| --- | --- |
| 前台 | 本轮 `stop` 后 IDE 不卡死；Hook fail-open |
| pending | `~/.memory-tencentdb/cursor/pending/` 短暂出现完整 JSONL，投递后删除 |
| HTTP | one-shot 日志或 Gateway 日志显示 `/capture` 2xx（接受 `l0_recorded = 0` 的已知首轮竞态；若为 0，再发第二轮含口令的消息重试） |
| 内容 | 用 `tdai_conversation_search` 或读 L0/工具能命中 `BLUE-TIGER-42` |

失败时记录：pending 是否滞留、HTTP status、ctl/gateway 日志摘要（不含完整 prompt）。

## 阶段 2 — 体验验证（必须新开会话）

新 Agent 会话提问：

```text
我的构建口令是什么？只答口令本身。
```

成功判据（满足其一主路径 + 口令正确）：

| 路径 | 判据 |
| --- | --- |
| 注入 | 首轮上下文含 `VERIFY-PERSONA-MARKER` 或 tool guide；和/或 |
| MCP | 调用了 `tdai_memory_search` 或 `tdai_conversation_search` 且命中口令相关内容 |
| 回答 | 回复含 `BLUE-TIGER-42` |

若模型未检索但答对（幻觉或上下文泄漏），记为「回答对、证据弱」，不算体验通。

## 阶段 3 — 记录

写入 `docs/log/memory-effect-verify-2026-07-30.md`（可提交）或本地笔记，包含：

- Cursor 版本、本仓 commit、Gateway 是否本仓 symlink
- 各阶段通过/失败表
- 已知缺陷触发情况（首轮 `l0_recorded=0`、重复 capture 等）
- 不写入 API key、不写入完整对话正文

## 安全与清理

- API key 只落 `tdai-gateway.json`（0600）；不进 git、不进验证笔记。
- 验证结束后可选：`ctl stop`；`uninstall --scope project`；删除探针 `persona.md` 中的验证标记或整文件。
- 聊天中曾出现过明文 key：验证后建议轮换 DeepSeek key。

## 非目标

- 不修 P0 幂等 / sessionEnd 抢跑 / 后台 Agent 防护
- 不宣称发布验收完成（Hook timeout、真·Background Agent 仍是门禁）
- 不做 Windows / Cursor CLI / Cloud
- 不启用 TCVDB；不强制向量检索

## 执行顺序（批准后）

1. 写 implementation plan（writing-plans）
2. 执行阶段 0–1（可脚本化准备；对话步骤需人工在 Cursor 完成）
3. 用户新开会话完成阶段 2
4. 写阶段 3 笔记并汇总结果
