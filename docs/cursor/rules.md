# Rules

> 策略文本注入 Agent 上下文；frontmatter 决定何时加载。

出处：[Cursor Rules](https://cursor.com/docs/rules)。

---

## 一句话

`.mdc` = 元数据 + Markdown 正文；Cursor 按类型决定是否进入会话。

---

## I/O

| 方向 | 内容 |
| --- | --- |
| 输入 | `.cursor/rules/*.mdc`（及用户 / 团队规则） |
| 输出 | 进入 Agent 上下文的规则文本 |

---

## 文件形态

| 要求 | 说明 |
| --- | --- |
| 必须 `.mdc` | 带 frontmatter |
| 纯 `.md` | `.cursor/rules` 下会被忽略 |

```yaml
---
description: 何时由 Agent 决定加载
globs: "**/*.ts"
alwaysApply: false
---

规则正文……
```

| 字段 | 作用 |
| --- | --- |
| `alwaysApply` | `true` 时每轮会话都带上 |
| `globs` | 匹配文件时自动附上 |
| `description` | 给 Agent 判断是否拉取 |

---

## 加载矩阵

| `alwaysApply` | `description` | `globs` | 行为 |
| --- | --- | --- | --- |
| `true` | 任意 | 任意 | 总是注入；忽略 globs / description |
| `false` | 任意 | 有 | 上下文出现匹配文件时自动附上；description 忽略 |
| `false` | 有 | 无 | Agent 按描述决定是否拉取 |
| `false` | 无 | 无 | 仅 `@` 提及时加载 |

对应 UI：Always Apply / Apply to Specific Files / Apply Intelligently / Apply Manually。

---

## 规则来源

| 来源 | 存放 |
| --- | --- |
| Project Rules | `.cursor/rules/*.mdc`（可进 git） |
| User Rules | Cursor 设置（本机，跨项目） |
| Team Rules | 团队仪表盘（可同步；可带 globs） |

冲突优先级（高 → 低）：Team Rules → Project Rules → User Rules。

| 目录习惯 | 说明 |
| --- | --- |
| 扁平 | 更易维护；官方更推荐 |
| 子目录 | 也可扫描 |

| 作用面 | 是否生效 |
| --- | --- |
| Agent Chat | 是 |
| Tab 补全 | 否 |
| User Rules → Cmd/Ctrl+K Inline Edit | 通常否 |

---

## 相关入口

| 入口 | 说明 |
| --- | --- |
| `AGENTS.md` | 项目根或嵌套子目录；更靠近当前文件的优先 |
| `CLAUDE.md` | 兼容 Claude Code；始终应用于会话 |
| `.cursorrules` | 遗留；将弃用，应迁到 `.mdc` |

---

## 与 Hooks 的分工

| 机制 | 适合 |
| --- | --- |
| Rules | 静态、可版本管理的策略与约定 |
| Hooks `additional_context` | 运行时动态注入（依赖会话/磁盘状态） |
