# Cursor Adapter PRD

## 一句话方案

Cursor Adapter 用每轮一个 append-only pending JSONL 保存 Hook 事件，`stop` 或 `sessionEnd` 唤醒 detached one-shot：

```text
Cursor Hook → pending JSONL → detached one-shot → global lock → current Gateway
```

前台不执行网络、Gateway 启动、健康检查和 pending 全量扫描。

## 范围与流程

v1 面向 Linux、macOS 的 Cursor 本地 IDE；Windows、Cursor CLI、Cursor Cloud 不在范围内。

| 输入 | 前台行为 | 后台输出 |
| --- | --- | --- |
| `sessionStart` | 注入 L3、L2 导航和检索指南 | `additional_context` |
| `beforeSubmitPrompt` | O_APPEND 一条 user 记录 | 不完整 pending |
| `afterAgentResponse` | O_APPEND 一条 assistant 记录 | 累积正文 |
| `stop` | O_APPEND 一条 stop 记录；spawn detached one-shot | `/capture` |
| `sessionEnd` | spawn detached one-shot | best-effort `/session/end` |
| MCP 调用 | L1 优先，需要证据时查 L0 | 两个只读搜索工具 |

```text
pending/<sha256(canonical_json([conversation_id, generation_id]))>.jsonl
```

one-shot 折叠 user、全部 assistant 和首个 stop。完整 pending 只在 capture 2xx 或明确永久错误后删除；不完整 pending 在最后修改 24 小时后清理。

JSONL 在本地文件系统上只做单次 O_APPEND 写入，不读旧文件、不加 turn lock、不 `fsync`。写入中崩溃可能丢当前事件，掉电可能丢最后一轮，删除回滚可能重复投递。

one-shot 是短生命周期进程：

1. 阻塞获取全局跨平台 Node 锁。
2. 清理超时的不完整 pending。
3. 有完整 pending 或 `sessionEnd` 请求时启动 Gateway。
4. 扫描全部完整 pending，并串行投递。
5. best-effort 处理 `/session/end` 后退出。

锁必须保留：现有 `scripts/memory-tencentdb-ctl.sh:226-257` 是“检查端口 → spawn”，并发 one-shot 会重复拉起 Gateway。实现加入固定版本的 `proper-lockfile`，并验证 heartbeat 覆盖 Gateway 启动和超过 60 秒的持锁请求。

| v1 包含 | v1 边界 |
| --- | --- |
| Hooks、Rule、MCP 配置与安全合并安装 | Gateway、TdaiCore、L0 改动 |
| L3/L2 轻注入，L1/L0 按需检索 | 子代理、后台 Agent capture |
| pending JSONL、detached one-shot、全局锁 | daemon、sequence、FIFO、claim、fencing |
| Node 原生 fetch、Bearer、可配置 timeout | 未合并的 #316 client |
| capture 2xx 前保留完整 pending | 服务端幂等、真实时间线、`l0_recorded > 0` |

当前 checkout 尚无 Cursor Adapter、Hook binary、安装器和 `proper-lockfile` 依赖；无待合并代码前置。

## 接受的 Gateway 语义

Adapter 只发送当前主干必填字段：

```text
user_content
assistant_content
session_key = cursor:<conversation_id>
```

不发送 `messages`，不增加 sequence、`capture_id` 或 `idempotency_key`。

| 现有语义 | 接受的影响 |
| --- | --- |
| Gateway 补写处理时刻与随机 ID | 延迟重投可能改变时间和 L0 日期分片 |
| 服务端没有 keyed capture 去重 | 响应丢失或本地删除回滚会重复 L0 |
| 每次 capture 都通知 pipeline | 可能重复增加 L1 计数、抽取或调用 LLM |
| HTTP 到达顺序决定处理顺序 | 不保证 FIFO 或用户轮次时间线 |

`l0_recorded = 0` 仍按 2xx ACK。它既可能来自正常内容过滤，也可能来自新 session 首轮的同毫秒 cursor 竞态；后者是当前 Gateway 主干缺陷，本次不修复。

仍不发送 `messages`：one-shot 在轮次结束后才启动 Gateway；真实 timestamp 会早于新建的 `pluginStartTimestamp`，被严格 cursor 系统性过滤。

capture timeout 默认 60 秒并可配置；超时保留 pending。

## 实现前门禁

真实 Cursor spike 必须确认：

1. 同轮各 Hook 的 generation 关联、多个 response 与 `stop` 顺序。
2. detached 子进程能活过 Hook 退出与 timeout。
3. `sessionStart.additional_context` 首轮可见。
4. 主 Agent、子代理和后台 Agent 可稳定区分。
5. `transcript_path` 在 `stop` 时的格式与完整性。

transcript 若能无歧义还原本轮，删除 before/after 采集链，由 `stop` 一次追加相同的 user、assistant、stop 记录；否则使用 JSONL fallback。第 1、2 项不成立时停止当前 capture 骨架，第 3、4 项不成立时重新设计对应入口或收窄范围。

## 安装

Cursor 会合并用户级与项目级 Hook，同一事件下两边命令都会执行。安装器只安装一个作用域，并在写入前同时检查：

```text
.cursor/hooks.json
~/.cursor/hooks.json
```

安装器写入含固定标识 `tencentdb-memory-cursor-v1` 的规范 command；另一作用域已有该标识时拒绝新增并报告路径。安装与卸载只改 Adapter 自己的 Hook、MCP 名称和 Rule，保留其他配置。

## 机会式重投

`sessionStart` 不唤醒 one-shot。spawn 失败或 one-shot 崩溃后，pending 只由后续 `stop` 或 `sessionEnd` 推进；没有后续事件时会长期滞留。24 小时 TTL 也只在下次 one-shot 执行清理。

## 验收

1. fallback 每轮只有一个 pending JSONL，无 RMW、turn lock、failed 或第二层 outbox。
2. 前台不执行网络、Gateway 启动、健康检查和 pending 全量扫描。
3. `stop`、`sessionEnd` 才唤醒 one-shot；`sessionStart` 不做 recover。
4. one-shot 在全局锁内启动 Gateway、扫描并串行投递。
5. 2xx 删除完整 pending；可重试和未知错误保留；永久错误记摘要后删除。
6. 不完整 pending 在 24 小时后由下次 one-shot 清理；完整 pending 不按 TTL 删除。
7. Adapter 使用原生 fetch，不依赖 #316 client。
8. `l0_recorded = 0` 仍视为 ACK；首轮竞态明确标为主干缺陷。
9. spike 覆盖 generation、detached、首轮注入、Agent 类型和 transcript。
10. 安装器阻止用户级与项目级 Adapter Hook 重复生效。
