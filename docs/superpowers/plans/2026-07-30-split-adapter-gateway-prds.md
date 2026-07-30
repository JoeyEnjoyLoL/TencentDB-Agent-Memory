# Adapter 与 Gateway PRD 拆分执行计划

> **已废弃：** Cursor Adapter 的 claim、sequence、FIFO 方案已被 `docs/316base/prd.md` 的单 pending JSONL + detached one-shot 方案替代。当前实现计划见 `docs/superpowers/plans/2026-07-30-cursor-adapter.md`，不要继续执行本计划。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将混合 PRD 拆成两个互不引用的目录，并明确本次只做 Cursor Adapter。

**Architecture:** `docs/316base/` 只描述 Cursor Adapter 的输入、状态、调用和验收；`docs/gateway-persistence/` 只描述服务端持久化语义。两份 PRD 分别以同目录 `spec.md` 为事实源，不声明彼此依赖。

**Tech Stack:** Markdown、Mermaid、Git

## Global Constraints

- `docs/316base/` 只保留 Cursor Adapter 内容。
- `docs/gateway-persistence/` 只保留 Gateway 持久化内容。
- 两个目录互不引用、互不声明依赖。
- Cursor PRD 必须明确“本次只做 Adapter”。
- 检索策略固定为“L3/L2 轻注入 + L1 优先搜索 + L0 证据回溯”。
- recover 使用 30 秒 lease 的原子 claim；同会话按单调序号从旧到新投递。
- 全局版本不兼容保留全部 spool；单条坏数据只隔离当前记录。
- 本次不实施 Gateway 持久化代码。
- 文档按摘要、范围、流程、细节、失败语义、验收渐进展开。

---

### Task 1: Cursor Adapter PRD

**Files:**
- Modify: `docs/316base/prd.md`
- Read: `docs/316base/spec.md`

**Interfaces:**
- Consumes: Cursor Adapter 已确认 spec。
- Produces: 只包含 Cursor Adapter 的云脑方案文档。

- [ ] **Step 1: 重写 PRD**

保留 Cursor Hooks、L2/L3 轻注入、L1/L0 主动检索顺序、MCP 配置、turn-state、durable spool、原子 claim、同会话 ordered drain、recover、end marker、客户端 HTTP 字段和错误处理。删除 strict ensure、JSONL、metadata、TdaiCore 下传、SQLite/TCVDB 迁移、确定性 message ID 和服务端验收。

- [ ] **Step 2: 核验边界**

Run:

```bash
rg -n "strict|dual-store|JSONL|metadata|capture_fingerprint|SQLite|TCVDB|Gateway 持久化语义 PR" docs/316base/prd.md
```

Expected: 无输出。

- [ ] **Step 3: 核验本次交付声明**

Run:

```bash
rg -n "本次只做 Adapter" docs/316base/prd.md
```

Expected: 至少一处匹配。

- [ ] **Step 4: 核验 review 修正**

Run:

```bash
rg -n "L3/L2 轻注入.*L1 优先搜索.*L0 证据回溯|原子 claim|session_sequence|blocked-incompatible|单条坏数据" docs/316base/prd.md
```

Expected: 五类约束均有匹配。

### Task 2: Gateway 持久化 PRD

**Files:**
- Create: `docs/gateway-persistence/prd.md`
- Read: `docs/gateway-persistence/spec.md`

**Interfaces:**
- Consumes: Gateway 持久化已确认 spec。
- Produces: 不包含 Cursor Adapter 的独立云脑方案文档。

- [ ] **Step 1: 新建 PRD**

只写 keyed capture、规范化、幂等作用域、确定性 message ID、双存储 ensure、schema migration、失败语义和验收。删除 Cursor hook、MCP、turn-state、spool、recover、end marker 和客户端安装内容。

- [ ] **Step 2: 核验边界**

Run:

```bash
rg -n "Cursor|Adapter|hook|spool|recover|MCP|end marker|316base" docs/gateway-persistence/prd.md
```

Expected: 无输出。

### Task 3: 文档验收

**Files:**
- Verify: `docs/316base/prd.md`
- Verify: `docs/gateway-persistence/prd.md`

**Interfaces:**
- Consumes: 两份拆分后的 PRD。
- Produces: 格式检查、单轮内容 review 和人类表达优化结果。

- [ ] **Step 1: 检查格式与交叉引用**

Run:

```bash
git diff --check -- docs/316base/prd.md docs/gateway-persistence/prd.md
rg -n "gateway-persistence" docs/316base
rg -n "316base" docs/gateway-persistence
```

Expected: 三条命令均无输出。

- [ ] **Step 2: Luna 单轮只读 review**

核验事实、范围、完整性和歧义。Reviewer 不修改文件；主 agent 逐条接受或拒绝 finding。

- [ ] **Step 3: Luna 人类表达优化**

只检查结构、措辞和渐进式披露，不改事实断言。

- [ ] **Step 4: 提交**

Run:

```bash
git add docs/316base/prd.md docs/gateway-persistence/prd.md
git commit -m "docs: split adapter and gateway PRDs"
```

Expected: commit 只包含两份 PRD。
