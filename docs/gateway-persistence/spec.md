# Spec：Gateway 持久化语义

## 摘要

带 `idempotency_key` 的 capture 使用确定性 message ID 和双存储 create-or-verify，服务重启后仍能识别重复请求与冲突。

## 目标

- keyed capture 只有在 JSONL 与 metadata 都完成后才返回 2xx。
- 同一 `session_key + idempotency_key` 与相同请求可安全重放。
- 同一 `session_key + idempotency_key` 与不同请求返回 409，禁止覆盖旧记录。
- legacy capture 保持现有行为。

## 范围

| 范围 | 结论 |
| --- | --- |
| `/capture` keyed 请求 | 支持 strict durable capture |
| key 与 fingerprint 下传 TdaiCore | 支持 |
| JSONL 与 metadata 幂等写入 | 支持 |
| SQLite schema migration | 支持 |
| TCVDB L0 record schema | 支持 |
| legacy capture 兼容 | 保持 |
| 客户端适配与本地 spool | 不包含 |
| MCP 配置与工具 | 不包含 |

## 输入与输出

| 输入 | 输出 |
| --- | --- |
| 带 `idempotency_key` 的 capture | strict dual-store ACK、重复成功或 409 |
| 不带 key 的 capture | legacy capture 结果 |
| metadata degraded | keyed 请求返回可重试的 503 |

## 请求标识

幂等作用域是 `session_key + idempotency_key`。不同 `session_key` 可独立使用相同 key，互不冲突。

服务端先将消息规范化：

- 请求包含非空 `messages` 时，保留数组顺序，逐条使用其 role 与 content。
- 请求未包含 `messages` 时，依次生成 user 与 assistant 两条消息。
- keyed 请求显式传入空 `messages` 时返回 400；legacy 请求保持现有行为。
- `message_index` 从 `0` 开始，按规范化后的消息顺序递增。

`canonical_json` 使用 UTF-8 JSON：对象键按 Unicode 码点升序排列，不写空白，数组保持顺序，`null` 保留，未提供字段不加入对象，字符串不做 Unicode 再归一化。

服务端按该算法计算请求指纹：

```text
capture_fingerprint =
  sha256(canonical_json(normalized CaptureRequest excluding idempotency_key))
message_scope =
  sha256(canonical_json([session_key, idempotency_key]))
message_id =
  capture:v1:<message_scope>:<message_index>
```

请求指纹覆盖规范化后的完整 capture 内容，不包含 `idempotency_key`。`idempotency_key` 与 `capture_fingerprint` 一起下传 TdaiCore。

## Strict capture

| 请求类型 | 行为 |
| --- | --- |
| 无 `idempotency_key` | 保持 legacy capture |
| 有 `idempotency_key` | 启用 strict dual-store ACK |
| metadata degraded | 返回 503 |
| fingerprint 冲突 | 返回 409 |

JSONL 与 metadata 都实现：

```text
ensure(message_id, capture_fingerprint, record)
```

| 已有状态 | 结果 |
| --- | --- |
| 不存在 | 创建 |
| 同 ID、同 fingerprint | 重复成功，不再次写入 |
| 同 ID、不同 fingerprint | 冲突，禁止覆盖 |

单侧已存在且 fingerprint 相同时，只补齐另一侧。任一侧失败均不返回 2xx；两侧 ensure 都成功后才推进 capture checkpoint。

embedding 可后台执行，失败不影响持久化 ACK。

## JSONL

JSONL ensure 在跨进程 L0 锁内执行：

1. 扫描全部分片。
2. 按 message ID 查找已有记录。
3. 校验 fingerprint。
4. 不存在时 append。
5. 完成持久化后释放锁。

锁覆盖扫描、校验和 append，避免并发重复写入。

## Metadata

metadata ensure 在存储事务内执行 insert-if-absent + fingerprint verification，不使用会覆盖旧记录的普通 upsert。

SQLite 为 `l0_conversations` 增加可空字段：

- `idempotency_key`
- `capture_fingerprint`

历史 legacy 行保持为空；读取、写入与迁移语句同步更新。TCVDB L0 record schema 同步增加两个字段。

## 数据结构

| 键/字段 | 取值 | TTL | 用途 |
| --- | --- | --- | --- |
| `idempotency_key` | 请求提供的有界字符串 | 随 L0 保留 | 重试标识 |
| `capture_fingerprint` | 规范化请求 SHA-256 | 随 L0 保留 | 冲突检测 |
| message scope | session key + idempotency key 的哈希 | 随 L0 保留 | 幂等作用域 |
| message ID | `capture:v1:<scope>:<index>` | 随 L0 保留 | 双存储共用主键 |

JSONL 与 metadata 都保存 `idempotency_key` 和 `capture_fingerprint`。

## 失败语义

| 情况 | 行为 |
| --- | --- |
| 同 ID、同 fingerprint | 返回重复成功 |
| 同 ID、不同 fingerprint | 返回 409 |
| JSONL 失败 | 返回非 2xx |
| metadata 失败 | 返回非 2xx |
| metadata degraded | 返回 503 |
| embedding 失败 | 记录错误，不影响 ACK |

## 验收

1. strict 语义只对携带 `idempotency_key` 的请求启用。
2. key 与规范化 fingerprint 下传 TdaiCore。
3. JSONL 与 metadata 使用确定性 message ID。
4. 两侧保存 key 与 fingerprint。
5. 两侧使用 create-or-verify，禁止覆盖不同 fingerprint 的旧记录。
6. 单侧存在且 fingerprint 相同时只补另一侧。
7. 任一存储失败返回非 2xx；degraded 返回 503。
8. 两侧 ensure 均成功后才推进 checkpoint。
9. 同一作用域的不同 fingerprint 在服务重启后仍返回 409。
10. 未携带 key 的调用方保持 legacy 行为。
11. keyed 请求的空 `messages` 返回 400；未提供时生成 user 与 assistant 两条消息。
12. SQLite 完成 nullable 字段迁移，TCVDB schema 同步支持新字段。
