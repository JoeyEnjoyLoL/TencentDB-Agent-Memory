# Spike 报告：Linux / Cursor 3.12.30

**日期：** 2026-07-30  
**平台：** Linux 6.8.0-124-generic  
**Cursor：** 3.12.30  
**安装：** 项目级 `.cursor/hooks.json` → `bin/memory-tencentdb-cursor.mjs spike`  
**运行时证据根：** `~/.memory-tencentdb/cursor/spike/`  
**本目录脱敏副本：** [hook-events.jsonl](./hook-events.jsonl)、[detached-sentinel.jsonl](./detached-sentinel.jsonl)

对照：[spec §实现前 Hook spike](../316base/spec.md)、[prd §实现前门禁](../316base/prd.md)。

---

## 结论摘要

| Spec # | 问题 | 结论 | 对方案影响 |
| --- | --- | --- | --- |
| 1 | 同轮 before/after/stop 的 `generation_id` 是否相同 | **部分成立** | 无子代理轮次同 gen；含子代理轮次 `after≠stop`，归并需 `conversation_id` + 时间序，不能单键 `generation_id` |
| 2 | 一轮是否多次 `afterAgentResponse`，且均早于 `stop` | **未观察到多次 after**；观察到的 after 均早于配对 stop（~218–314ms） | 当前样本支持「单 after 封口」；不能据此假设多 after |
| 3 | detached 能否活过 Hook 退出 | **通过** | 可继续 one-shot 骨架 |
| 4 | Hook timeout 单位/默认值 | **未测** | 仍待补 |
| 5 | `sessionStart.additional_context` 首轮可见 | **通过** | 注入入口可用 |
| 6 | 主/子/后台 Agent 区分 | **部分通过** | 子代理用独立事件排除；真·`is_background_agent=true` 未触发；后台 Task 缺 `subagentStop` |
| 7 | `stop` 时 transcript 存在与形态 | **通过（形态）** | path 稳定、含 user/assistant/turn_ended；正文完整性未全文审计（spike 刻意不落正文） |

**发布门禁（prd #9）：** 尚未完全关闭——缺 Hook timeout 实测、真·Background Agent、后台 Task Stop 行为确认。后续 transcript 正文完整性复核已通过，见 [docs/spike-agent/INDEX.md](../spike-agent/INDEX.md)。

---

## 操作过程

1. 项目 scope 安装 spike hooks（`sessionStart` / `beforeSubmitPrompt` / `afterAgentResponse` / `stop` / `sessionEnd` / `subagentStart` / `subagentStop`）。
2. 新开会话验证首轮 `SPIKE_MARKER_tencentdb-memory-cursor-v1 first_turn_visible` 注入可见。
3. 完成多轮主 Agent 交互，采集 before/after/stop 与 detached sentinel。
4. 同步 Task 子代理：触发成对 `subagentStart` + `subagentStop`。
5. 后台 Task（`run_in_background`）：触发 `subagentStart`；transcript 已 `turn_ended` 且父轮 stop 已发生，**仍无**对应 `subagentStop`。
6. 手动 CLI 探测写入一条 `conversation_id=test-spike-verify` 的 `sessionStart`（非 Cursor 触发，见污染说明）。

---

## 事件时间线（脱敏）

| 时间 | 事件 | conversation | generation | bg | parent | status/reason | transcript |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20:22:27.914 | afterAgentResponse | 6db12522 | 885ba282 | — | — | — | yes |
| 20:22:28.228 | stop | 6db12522 | 885ba282 | — | — | completed | yes |
| 20:25:00.583 | sessionEnd | f18d21d3 | f998bfb5 | false | — | user_close | yes |
| 20:25:00.650 | sessionStart | 7f41cec9 | (empty) | false | — | — | no |
| 20:25:10.759 | beforeSubmitPrompt | 7f41cec9 | 6d71cd47 | — | — | — | no |
| 20:26:28.022 | sessionStart | test-spi* | (empty) | — | — | — | no |
| 20:26:40.181 | afterAgentResponse | 7f41cec9 | 6d71cd47 | — | — | — | yes |
| 20:26:40.454 | stop | 7f41cec9 | 6d71cd47 | — | — | completed | yes |
| 20:27:04.130 | beforeSubmitPrompt | 7f41cec9 | 0a4f6f31 | — | — | — | yes |
| 20:27:17.891 | subagentStart | 7f41cec9 | 7f41cec9 | — | 7f41cec9 | — | yes |
| 20:27:24.008 | subagentStop | 7f41cec9 | 7f41cec9 | — | 7f41cec9 | completed | yes |
| 20:27:47.112 | subagentStart | 7f41cec9 | 7f41cec9 | — | 7f41cec9 | — | yes |
| 20:29:31.389 | afterAgentResponse | 7f41cec9 | 0a4f6f31 | — | — | — | yes |
| 20:29:31.607 | stop | 7f41cec9 | **9561d258** | — | — | completed | yes |
| 20:30:17.855 | beforeSubmitPrompt | 7f41cec9 | 6050ba6f | — | — | — | yes |

\* `test-spi…` = 人工 CLI 探测，非 IDE Hook。

事件计数：`afterAgentResponse×3` `stop×3` `beforeSubmitPrompt×3` `sessionStart×2` `sessionEnd×1` `subagentStart×2` `subagentStop×1`。

---

## 门禁细项

### 1. generation 关联

```text
轮次 A (6db12522): after=885ba282 → stop=885ba282   同 gen, Δ314ms
轮次 B (7f41cec9): before=after=stop=6d71cd47         同 gen, Δ273ms
轮次 C (7f41cec9): before=after=0a4f6f31, stop=9561d258  异 gen, Δ218ms
                   ↑ 本轮含同步+后台 Task 子代理
```

**诊断：** 简单轮次可用 `generation_id` 串 before/after/stop；含子代理（或 Cursor 内部再开 generation）时 stop 可能换 gen。  
**建议归并：** `(conversation_id, 时间窗)` 为主，`generation_id` 为辅；禁止假设 after.gen == stop.gen 恒成立。

### 2. 多次 afterAgentResponse

三轮完整 stop 均为 **1×after → 1×stop**。transcript 内可有多条 `assistant`，但 Hook 层未观察到多次 `afterAgentResponse`。

### 3. detached 存活

| stop gen | sentinel Δms | `detached_alive` |
| --- | --- | --- |
| 885ba282 | 2359 | true |
| 6d71cd47 | 2330 | true |
| 9561d258 | 2259 | true |

`spike-sentinel` 默认延迟约 2s（`MEMORY_TENCENTDB_CURSOR_SPIKE_DELAY_MS`），三次均在 stop 后写出证据 → **通过**。

### 4. Hook timeout

未配置/未测量单位与默认值。**待补。**

### 5. 首轮 additional_context

- CLI/dist：`sessionStart` 回包含  
  `SPIKE_MARKER_tencentdb-memory-cursor-v1 first_turn_visible`
- 会话 `7f41cec9` 的 hooks 上下文首轮可见该标记 → **通过**

### 6. Agent 类型

| 面 | 实测 |
| --- | --- |
| 主会话 sessionStart | `is_background_agent=false` 在 input_keys 中 |
| sessionEnd | 同上 |
| before / after / stop | **无** `is_background_agent`、`parent_conversation_id`、`subagent_id` |
| 同步 Task | `subagentStart`+`subagentStop`；含 `parent_conversation_id`、`subagent_id`；Start 含 `is_parallel_worker` |
| 后台 Task | 仅 `subagentStart`；transcript 已结束；父轮 stop 后仍无 `subagentStop` |
| 真·Background Agent | **0 条** `is_background_agent=true` |

**排除策略（基于本样本）：**

- 不 capture `subagentStart` / `subagentStop`。
- 主 capture 只认 before/after/stop；它们本身不会带上子代理字段。
- 不能依赖「等 subagentStop」清理后台 Task；也不能宣称已验证 `is_background_agent=true` 路径。

注意：子代理事件上 `conversation_id == parent_conversation_id ==` 父会话 id；`generation_id` 亦等于父 conversation id。区分靠 **事件名 + `subagent_id`**，不是靠不同 conversation。

### 7. transcript @ stop

- 三次 stop 均 `transcript_exists=true`，path 位于 Cursor `agent-transcripts/<conversation_id>/…jsonl`。
- 行形态：`{role, message}`；角色样本含 `user` / `assistant` / `turn_ended`。
- spike 只记 path/size/exists，不复制正文 → **格式稳定已证；全文无歧义还原未做人工全文核对**。

---

## 字段矩阵（input_keys 并集）

| 事件 | 稳定区分相关字段 |
| --- | --- |
| sessionStart | `is_background_agent`, `composer_mode`, … |
| sessionEnd | `is_background_agent`, `reason`, `final_status`, … |
| beforeSubmitPrompt | `prompt`, `attachments`, `composer_mode`；无 bg/parent |
| afterAgentResponse | `text`, token 字段；无 bg/parent |
| stop | `status`, `loop_count`；无 bg/parent |
| subagentStart | `parent_conversation_id`, `subagent_id`, `subagent_type`, `is_parallel_worker`, `task`, `tool_call_id` |
| subagentStop | `parent_conversation_id`, `subagent_id`, `status`, `agent_transcript_path`, … |

**证据记录器缺口：** `recordSpikeEvent` 未持久化 `subagent_id` / `is_parallel_worker` / `subagent_type` 的值，仅通过 `input_keys` 证明字段存在。后续若要定量对比并行 vs 同步，需扩展 recorder。

---

## 污染与局限

1. 人工 CLI：`conversation_id=test-spike-verify` 的 sessionStart。
2. 未测：macOS、Hook timeout、Cloud/真·Background Agent、多 after 强制场景。
3. 源码 `src/adapters/cursor/cli.ts` 与已构建 `dist/cursor.mjs` 曾存在 sessionStart 标记回包差异；**本 spike 以 dist/安装二进制为准**（实测回包含 SPIKE_MARKER）。
4. 本报告写入时会话仍在继续，后续事件以 `~/.memory-tencentdb/cursor/spike/` 为准；本目录 jsonl 为 2026-07-30 落盘快照。

---

## 对 Adapter 的直接建议

1. **继续** one-shot / detached 骨架（门禁 3 通过）。
2. **继续** sessionStart 注入（门禁 5 通过）。
3. **删除**跨 Hook generation 归并：不要假设 after.gen === stop.gen。
4. **排除** 子代理：忽略 subagent\* 事件即可；勿在 after/stop 上找 parent 字段。
5. **收窄** 范围声明：真·Background Agent 与后台 Task Stop 未闭环前，不宣称 prd #9 完全满足。
6. 后续全文无歧义审计已完成；采用 transcript stop-only，删除生产 before/after JSONL fallback。见 [Agent 复核](../spike-agent/INDEX.md)。

---

## 复现

```bash
# 安装（项目级）
node bin/memory-tencentdb-cursor.mjs install --scope project

# 证据
tail -f ~/.memory-tencentdb/cursor/spike/hook-events.jsonl
cat ~/.memory-tencentdb/cursor/spike/detached-sentinel.jsonl
```
