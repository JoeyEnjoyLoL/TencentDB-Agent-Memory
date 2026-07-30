# Spec：Cursor Adapter

## 本次只做 Adapter

本次交付只实现 Cursor Adapter：接入 Cursor Hooks、加载长期记忆、可靠投递对话、配置检索工具，并在 capture 完成后结束会话。

不修改 Gateway 服务端、TdaiCore、L0 存储、MCP server 或公共持久化语义。

## 目标

v1 为 Cursor 提供 L0→L3 长期记忆：

- 会话开始注入 L3 Persona 与 L2 场景导航。
- 一轮结束后可靠投递 L0 capture。
- 会话中优先检索 L1，必要时回溯 L0 原文。
- 全部 capture 被服务端接受后再结束会话。

## 范围

| 范围 | 结论 |
| --- | --- |
| Cursor Agent Hooks | 支持 |
| Cursor 本地 stdio MCP 配置 | 支持 |
| Cursor Adapter 安装与测试 | 支持 |
| Gateway 服务端改动 | 不包含 |
| TdaiCore 与 L0 存储改动 | 不包含 |
| MCP server 改动 | 不包含 |
| Cloud agents | 不包含 |
| Cursor CLI | 不包含 |
| 符号短期记忆 offload | 不包含 |
| 多用户、多记忆库隔离 | 不包含，沿用单 dataDir |

## 输入与输出

| 输入 | Adapter 产物/调用 |
| --- | --- |
| Cursor hook payload | 初始上下文、turn-state、capture 请求、session-end 请求 |
| `persona.md`、`scene_index.json` | L3 Persona 与带绝对路径的 L2 导航 |
| Gateway 地址与鉴权配置 | HTTP capture、health、session-end 调用 |
| MCP 配置 | recall/search 工具入口 |

## 总体方案

```mermaid
flowchart TD
  A[Cursor Hooks] --> B[Cursor Adapter]
  B --> C[turn-state]
  B --> D[durable spool]
  D --> E[原子 claim]
  E --> F[同会话按旧到新 HTTP capture]
  F -->|2xx| G[删除 claim]
  F -->|可重试失败| D
  H[Cursor mcp.json] --> I[现有 stdio MCP]
  I --> J[L1 search]
  J --> K[L0 evidence]
```

Cursor Adapter 只负责客户端状态与调用时序。服务端返回 2xx 时视为请求已被接受；Adapter 不声明服务端内部写入方式。

## MCP 配置

Cursor 从项目级 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json` 加载配置：

```json
{
  "mcpServers": {
    "tencentdb-memory": {
      "command": "memory-tencentdb-mcp",
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420",
        "TDAI_GATEWAY_API_KEY": "replace-me"
      }
    }
  }
}
```

推荐在 Cursor MCP 工具界面只启用 recall/search，禁用 `tdai_capture` 与 `tdai_session_end`。该设置可被用户撤销，只是操作性防护；重新启用写工具后，写操作会绕过 Adapter 的 spool 与 end marker。

### 检索策略

`sessionStart` 只做轻量注入：

- L3 Persona 提供稳定偏好。
- L2 导航提供场景入口和绝对路径。
- 简短工具指南明确检索顺序，不注入 L1/L0 正文。

Agent 需要历史信息时：

1. 先调用 `tdai_memory_search` 搜索 L1 结构化记忆。
2. L1 不足、需要原话或证据时，再调用 `tdai_conversation_search` 回溯 L0。
3. 命中 L2 场景时，按导航中的绝对路径读取场景块。

**检索顺序：L3/L2 轻注入 → L1 优先搜索 → L0 证据回溯。** 不在每轮强制注入动态召回结果。

## Hook 映射

| 输入 | 动作 | 输出 |
| --- | --- | --- |
| `sessionStart` | 分别读取 L3 与 L2；有界 recover 旧 spool | `additional_context` |
| `beforeSubmitPrompt` | 分配会话序号，按 conversation/generation 保存 user prompt | turn-state |
| `afterAgentResponse` | 配对 turn，先落 spool，再按顺序 drain 本会话 | L0 capture |
| `sessionEnd` | 检查本会话 turn-state 与 spool | `/session/end` 或 pending end marker |

`sessionStart` 没有 query，不调用 recall；它直接读取 `persona.md` 与 `scene_index.json`。文件缺失时跳过对应部分，不阻塞会话。

## Capture 标识

每轮使用稳定的 Adapter 内部标识：

```text
capture_id = cursor:v1:<sha256(canonical([conversation_id, generation_id]))>
idempotency_key = capture_id
```

`capture_id` 使用小写十六进制 SHA-256，保持有界 ASCII。capture 请求发送：

- `user_content`
- `assistant_content`
- `session_key`
- `idempotency_key`

Adapter 不发送可选 `messages`，也不提交服务端内部指纹。

## Durable spool

durable spool 是先于网络请求落盘的持久队列文件。

`beforeSubmitPrompt` 在 session lock（会话锁）内完成：

1. 获取 session lock。
2. 为本会话分配单调递增的 `session_sequence`，写入 turn-state。
3. durable publish turn-state 后释放锁。

completion 的 turn-state→spool 转换在同一把锁内完成：

1. 按 conversation/generation 读取已有 turn-state 与 `session_sequence`。
2. 写临时 spool，完成文件 `fsync`、原子 rename 与父目录 `fsync`。
3. spool 发布成功后删除 turn-state。
4. 释放锁。
5. 触发本会话 ordered drain。

### 同会话顺序与投递

所有发送路径都走 ordered drain。`afterAgentResponse` 不绕过旧 spool 发送当前 capture；drain 按 `session_sequence` 从小到大处理，同一会话最多一个 capture 在途。

### 原子认领（claim）

同一会话任何时刻最多一个 capture 在途：

1. 在 session lock 内回收超过 30 秒的 stale claim。
2. 若本会话已有未过期 claim，本轮跳过该会话。
3. 按 `session_sequence` 从小到大选择最旧 pending spool。
4. 通过同一文件系统内的原子 rename 将其从 `pending/` 移到 `claimed/`。
5. 释放锁后发送 HTTP 请求。
6. 2xx 时删除 claim；可重试失败时原子移回 `pending/`；单条永久错误移入 dead-letter。

claim 记录 `claimed_at` 与 owner。recover 崩溃后，后续触发器可在 30 秒 claim lease 到期后重新投递。多个 recover 可并发处理不同会话，不能并发处理同一会话。

Adapter 保证 durable at-least-once delivery，不声明服务端跨重启去重或 effectively-once。

## Recover

recover 不作为常驻 daemon：

| 触发点 | 行为 |
| --- | --- |
| `sessionStart` | 有界处理旧 spool |
| `afterAgentResponse` | 将当前 capture 入队后按序 drain，再小批量 recover |
| `sessionEnd` | 尝试清空本会话 spool |
| Gateway 启动成功后 | 执行一次有界 recover |

recover 每次成功投递或隔离单条坏数据后，继续 claim 该会话下一条。pending 与 claimed 均为空时，检查该会话的 pending end marker 并重试 `/session/end`。即使启动 recover 时已经没有 spool，也执行一次该检查。

只有服务最终恢复且后续至少触发一次 recover 时，pending spool 才能完成投递。

## Session end

同一 session lock 覆盖 turn-state、spool 与 end marker（结束标记）的状态转换：

- `sessionEnd` 先 durable publish `pending` marker。
- 有待配对 turn、pending spool 或 claimed spool 时，不调用 `/session/end`。
- 本会话 capture 全部收到 2xx 后，再调用 `/session/end`。
- recover 启动或每次成功投递后，检查并 flush 满足条件的 `pending` marker。
- 请求成功后将 marker 原子改为 `sent`，不立即删除。
- 晚到 completion 发现 `sent` 时，先改回 `pending`，再发布 spool。
- 下一次 `sessionStart` 确认无待处理状态后，清理 `sent` marker。

`/session/end` 失败时保留 `pending`。合法的延迟 completion 必须已有 turn-state；无 turn-state 的后到 completion 视为协议错误。

## 数据结构

| 键/字段 | 取值 | TTL | 用途 |
| --- | --- | --- | --- |
| `session_key` | `cursor:<conversation_id>` | 随会话数据保留 | 会话分组 |
| `capture_id` | `cursor:v1:<sha256(...)>` | 随 spool 保留 | 稳定 turn 标识 |
| `idempotency_key` | 等于 `capture_id` | 随请求保留 | HTTP 重试标识 |
| `session_sequence` | 会话内单调递增整数 | 随 turn/spool 保留 | 同会话旧到新排序 |
| turn-state | conversation + generation + sequence | 24 小时清理孤儿 | turn 配对 |
| pending spool | `<sha256(capture_id)>.json` | claim 前保留 | 等待投递 |
| claimed spool | record + owner + `claimed_at` | 2xx 后删除；30 秒可回收 | 原子占有 |
| end marker | `pending` / `sent` | 下次 sessionStart 清理 sent | session-closing barrier |
| dead-letter | permanent protocol error | 人工处理后清理 | 失败证据 |
| blocked-auth | 401/403 | 配置修复后恢复 | 全局鉴权阻塞 |
| blocked-incompatible | 版本或协议能力不匹配 | 升级或降级后恢复 | 全局兼容性阻塞 |

## 失败语义

| 类别 | 情况 | 行为 |
| --- | --- | --- |
| Hook | 内部异常 | 输出 `{}` 并退出 0 |
| 网络 | 网络错误、408、425、429、5xx | claim 移回 pending，后续 recover 重投 |
| 单条数据 | 400、409、413、422 | 只将当前 claim 移入 dead-letter，继续同会话下一条 |
| Gateway 全局 | 401、403 | 标记全局鉴权阻塞 `blocked-auth`，claim 移回 pending |
| Gateway 全局 | `/health` 版本不受支持 | 标记全局兼容性阻塞 `blocked-incompatible`，保留全部 spool |
| Gateway 全局 | capture 接口返回 404、405 或响应结构不兼容 | 标记 `blocked-incompatible`，保留全部 spool |
| MCP 全局 | 初始化拒绝、协议版本不兼容 | 报告兼容性错误，不影响 capture spool |
| MCP 全局 | 缺少 L1/L0 两个只读工具 | 报告兼容性错误，不降级为写工具 |
| Session end | `/session/end` 失败 | 保持 marker 为 `pending` |
| MCP 单次 | 工具调用失败 | 返回该次工具错误 |

Gateway 兼容性由 `/health.version`、必需接口与响应结构核验；MCP 兼容性由 initialize 与 `tools/list` 核验。支持版本范围随 Adapter 发布物固定，不从远端动态放宽。

dead-letter 不自动重试，也不阻塞后续合法 capture；blocked-auth 与 blocked-incompatible 不消费单条重试次数。前台 capture 网络预算为 1 秒，hook 总超时为 5 秒并 fail-open。

## 验收

1. 文档和代码均明确本次只做 Cursor Adapter。
2. Adapter 不修改 Gateway、TdaiCore、L0 存储或 MCP server。
3. hook、capture 与 recover 统一使用现有 HTTP client。
4. `capture_id` 为稳定的有界 ASCII 哈希，且 `idempotency_key = capture_id`。
5. completion 在同一 session lock 内先 durable publish spool，再删除 turn-state。
6. spool 使用临时文件、文件 `fsync`、原子 rename 与父目录 `fsync` 发布。
7. 所有发送路径使用原子 claim；claim 崩溃后可按 30 秒 lease 回收。
8. 同一会话严格按 `session_sequence` 从旧到新投递，最多一个 capture 在途。
9. capture 不发送可选 `messages`；2xx 后才删除 claim。
10. 单条坏数据只隔离当前 claim；全局版本或协议不兼容保留全部 spool。
11. 有待配对 turn、pending spool 或 claimed spool 时不发送 `/session/end`。
12. 初始上下文明确“L3/L2 轻注入 + L1 优先搜索 + L0 证据回溯”。
13. MCP 只新增 Cursor 配置、检索策略与兼容性检查，不修改 MCP server。
