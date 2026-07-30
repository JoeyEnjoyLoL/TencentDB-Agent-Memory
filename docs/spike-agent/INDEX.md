# Cursor Transcript Agent 复核

**日期：** 2026-07-30  
**来源：** 本机 Cursor Hook 原始事件与对应 transcript  
**隐私：** 不复制 prompt、assistant 正文或本机绝对路径

## 结果

| 检查 | 结果 |
| --- | --- |
| 可与 Hook 长度记录配对的完整轮次 | 6 |
| `<user_query>` 正文长度匹配 `beforeSubmitPrompt.prompt_length` | 6/6 |
| 最终非空 assistant text 长度匹配 `afterAgentResponse.text_length` | 6/6 |
| 最后一轮存在 `turn_ended` | 6/6 |
| 观察到 after/stop generation 不一致 | 至少 2 轮 |

transcript 行为稳定：

- 记录形态为 `{role, message}`。
- user 正文位于 `<user_query>\n...\n</user_query>`。
- assistant 正文位于 message content 的 text item。
- `turn_ended` 可作为完整轮次边界。

## 决策

跨 Hook generation 不能可靠归并，原 before/after JSONL fallback 不成立。

生产 Adapter 改为：

1. 只在 `stop` 读取 `transcript_path`。
2. 提取最后一个 `turn_ended` 封口的 user 与最终 assistant。
3. 用一个 Buffer 一次 O_APPEND 写入 user、assistant、stop。
4. 不安装生产 `beforeSubmitPrompt` / `afterAgentResponse` Hook。

Hook timeout、真·Background Agent、后台 Task Stop 仍未闭环，发布门禁保持未关闭。
