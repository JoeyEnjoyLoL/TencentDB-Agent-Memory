# 运行面与可用性

> 同一套 Hooks / Rules / MCP，在本地 IDE、Cloud Agent、CLI 上可用性不同。

出处：[Cursor Hooks — Cloud agent support](https://cursor.com/docs/hooks)、[MCP](https://cursor.com/docs/mcp)、[Rules](https://cursor.com/docs/rules)。

---

## 一句话

本地 IDE 挂点最全；Cloud 只跑仓库内命令型 Hook，且缺少 session 生命周期钩子。

```mermaid
flowchart TD
  IDE[本地 IDE<br/>挂点最全]
  Cloud[Cloud Agent<br/>命令型 Hook / 无 session 起止]
  CLI[Cursor CLI<br/>独立运行面]
```

---

## 运行面

| 面 | 说明 |
| --- | --- |
| 本地 IDE | Agent Chat / Cmd+K；用户级与项目级配置都可用 |
| Cloud Agent | 云端执行；主要加载项目 / 团队 / 企业 Hook |
| Cursor CLI | 独立运行面；部分 App Hook（如 `workspaceOpen`）可用，完整差集以[官方文档](https://cursor.com/docs/hooks)为准 |

---

## Cloud Agent 与 Hooks

### 会跑

| Hook | Cloud |
| --- | --- |
| `beforeShellExecution` / `afterShellExecution` | 是 |
| `beforeReadFile` / `afterFileEdit` | 是 |
| `preToolUse` / `postToolUse` / `postToolUseFailure` | 是 |
| `subagentStart` / `subagentStop` | 是 |
| `beforeSubmitPrompt` | 是 |
| `preCompact` | 是 |
| `afterAgentResponse` / `afterAgentThought` | 是 |
| `stop` | 是 |

### 不跑 / 不适用

| Hook | 原因 |
| --- | --- |
| `sessionStart` | 云端可能先只读探索；Hook 加载偏晚，不是真正 session 起点 |
| `sessionEnd` | 绑定 IDE 会话边界，Cloud 无对等生命周期 |
| `beforeMCPExecution` / `afterMCPExecution` | 只读探索阶段时机不清，官方暂缓 |
| Tab Hooks | Tab 是 IDE 能力 |
| `workspaceOpen` | App / IDE 生命周期 |

### 配置来源

| 来源 | Cloud |
| --- | --- |
| 项目 `.cursor/hooks.json` | 加载 |
| Team / Enterprise | 可加载（企业） |
| 用户 `~/.cursor/hooks.json` | 不加载（无本机 home） |

| 约束 | 说明 |
| --- | --- |
| 执行类型 | 只支持**命令型** Hook；Prompt-based 在 Cloud 不可用 |
| 只读探索 | 可能整段不跑 Hook；可写环境就绪后才开始 |

---

## 三大 Hook 面（本地 IDE）

| 面 | 事件族 |
| --- | --- |
| Agent | session / tool / prompt / response / stop / compact… |
| Tab | `beforeTabFileRead`、`afterTabFileEdit` |
| App | `workspaceOpen` |

---

## Rules / MCP 跨面注意

| 机制 | 注意 |
| --- | --- |
| Rules | 项目 `.mdc` 可随仓库进 Cloud；User Rules 依赖本机设置 |
| MCP | 远程 URL 更易在云端使用；stdio 依赖云端能否跑同一命令 |
| 用户级 `mcp.json` | Cloud VM 通常不可见 |

---

## 能力边界速记

| 需求 | 更合适的面 |
| --- | --- |
| 会话创建注入 / 会话结束清理 | 本地 IDE（`sessionStart` / `sessionEnd`） |
| 提交前校验 | IDE 与 Cloud 均可（`beforeSubmitPrompt`） |
| Shell / 文件门控 | IDE 与 Cloud 均可 |
| Tab 补全策略 | 仅本地 IDE |
| 本机用户级个人配置 | 仅本地 IDE |
