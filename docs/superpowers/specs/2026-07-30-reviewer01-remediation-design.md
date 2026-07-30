# Cursor Adapter Reviewer01 Remediation Design

## 目标

采纳 `docs/log/reviewer01.txt` 中与当前代码和实测证据一致的部分，同时保持：

- 不修改 Gateway、TdaiCore、L0。
- capture 仍只发送三个必填字段。
- 前台 Hook fail-open，不执行网络。
- Hook timeout、真 Background Agent 仍是发布门禁。

## Finding 判断

| # | 判断 | 处理 |
| --- | --- | --- |
| 1 | 部分成立 | 保留已接受的重复投递语义；不发送带历史时间戳的 `messages`，只补 pending 删除失败日志 |
| 2 | 不成立 | `/session/end` 只 flush 当前已有 session buffer，不阻止后续 capture；继续保持 best-effort，不新增 marker |
| 3 | 成立 | 用 `sessionStart` 持久化顶层会话许可；`stop` 无许可则不 capture |
| 4 | 成立 | release 失败写 bounded 日志，不让 `ERELEASED` 覆盖处理结果 |
| 5 | 成立 | 全局锁等待改为有限 120 秒；owner drain 到静止，减少等待者退出后遗留 pending |
| 6 | 证据不足 | 当前真实 stop 样本只有 `completed`；不猜测其他 status 语义 |
| 7 | 成立 | Hook JSON 解析错误只写固定分类，不写解析器原始消息 |
| 8 | 成立 | 修复 Cursor 新增的 installer 与 MCP test typecheck 错误；installer JSON 改为 unknown-first narrowing |
| 9 | 暂不采纳 | 剩余真实 Spike 仍依赖诊断命令；生产安装器不会注册 spike |
| 10 | 不采纳 | 严格逆操作需要额外安装前快照；当前安全保留未知配置优先 |
| 11 | 成立 | transcript 必须位于明确的 Cursor projects 根目录；HOME 缺失改用 OS homedir |

## 会话分类

新增轻量 session marker：

```text
~/.memory-tencentdb/cursor/sessions/
└── <sha256(conversation_id)>.top-level
```

- `sessionStart.is_background_agent === false`：以临时文件加 rename 原子写入空 marker，再返回 L3/L2 context。
- `sessionStart.is_background_agent !== false`：删除同名 marker，且不注入 context。
- `stop`：先检查 marker。不存在时记录不含正文的 `stop_skipped_unclassified`，不读 transcript、不写 pending，但仍唤醒 worker。
- `sessionEnd`：先按现有语义唤醒 worker，再 best-effort 删除 marker。
- marker 不保存 conversation ID 或正文；文件名只使用 SHA-256。

该策略 fail-closed。即使未来 Background Agent 的 `stop` 仍不带分类字段，也不会混入顶层记忆。由于尚无真实 `is_background_agent=true` 生命周期证据，发布门禁仍不关闭。

## Worker 修复

- 全局锁 heartbeat 保持 `stale=180s`、`update=10s`。
- 等锁最多约 120 秒；失败写 `lock_acquire_failed` 后退出，pending 保留。
- owner 在每次成功处理一批后重新扫描，直到没有完整 pending。
- retryable capture 仍保留文件并结束本轮 drain。
- capture ACK 或永久错误后的 `unlink` 失败写 `pending_delete_failed`；不得误报 `capture_acked`。
- `release()` 失败写 `lock_release_error`，不向 detached 入口抛出。

## 输入、路径与类型

- Hook 输入 JSON 错误只记录 `hook_input_error` 与固定 reason，例如 `invalid_json`。
- `CursorConfig` 增加 `transcriptsRoot`：
  - 默认：`<os homedir>/.cursor/projects`
  - 可用 `MEMORY_TENCENTDB_CURSOR_TRANSCRIPTS_ROOT` 覆盖。
- `appendTranscriptTurn` 要求 realpath 位于 `transcriptsRoot` 内，并继续执行 16 MiB、普通文件、dev/ino/size/mtime/ctime 稳定性检查。
- installer 以 `Record<string, unknown>` 解析外部 JSON，通过小型 narrowing helper 后再访问字段。
- MCP test 使用生产 request 函数签名，不再把无约束 Vitest Mock 传入。

## 测试

按 TDD 逐项新增：

1. Background/unclassified stop 不 capture；top-level sessionStart 后可 capture；sessionEnd 清 marker。
2. lock compromised 后 release 报错只记日志。
3. 锁等待配置有限；owner 成功后重扫新 pending。
4. JSON parse 错误日志不含输入片段。
5. ACK 后 unlink 失败不误报成功。
6. transcript 拒绝 projects 根目录外路径和 symlink 越界。
7. Cursor 相关 TypeScript error 清零。

最后运行 Cursor suite、全量测试、build、定向 typecheck 与 `git diff --check`。
