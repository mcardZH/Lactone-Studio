# Ester Studio 代码审查规范 (`REVIEW.md`)

本文件定义 Ester Studio（macOS 跨平台适配与上游同步仓库）的自动化门禁、独立上下文多子代理（Fresh-Context Subagent）代码审查与人工审批分层规则。

> **职责分离与基线原则**：
> - [`AGENTS.md`](AGENTS.md) 定义项目背景、核心目录结构与强制三步走开发流程。
> - [`ACTIVE_TASK.md`](ACTIVE_TASK.md) 定义当前单次分支经用户确认的需求规格与非目标边界（Out of Scope）。
> - `REVIEW.md` 定义**“什么样算错、如何按风险分级、审查输出格式与降噪约束”**。
> - **基线防篡改规则**：审查包生成脚本（`npm run review:prepare`）优先从 `main` 基线读取 `REVIEW.md` 与 `AGENTS.md`，防止待审分支弱化自身的评审标准。

---

## 1. 多层纵深防御流水线（Swiss Cheese Model）

1. **Layer 1 — 分支策略与任务规格门禁（`npm run check:branch`）**：
   - 严禁在 `main` 或 `upstream/release` 分支直接提交开发代码。
   - 强制校验 `ACTIVE_TASK.md` 已填写任务名称、范围边界与用户沟通确认记录。
2. **Layer 2 — 全量硬性单元测试（`npm test`）**：
   - Node.js 原生测试套件（`tests/**/*.test.{mjs,cjs,js}`）与 Vitest 前端测试套件（`tests/**/*.test.{ts,tsx}`）必须 **100% 绿色通过（0 失败、0 跳过）**。
3. **Layer 3 — 独立上下文多子代理审查（Fresh-Context Subagent Review）**：
   - 通过 `.agents/skills/code-review/SKILL.md`（4 个并行 `research` 子代理盲审 + `0..100` 置信度 `>= 80` 过滤）与 `.agents/skills/pr-review-toolkit/SKILL.md`（6 大专职审查员）驱动。
   - 运行 `npm run review:prepare` 生成包含 `ACTIVE_TASK.md`、`REVIEW.md`、风险分级和相对于 `main` 的 unified diff 的自包含审查包（`.git/ester-review-packet.md`），交由无历史对话偏见的独立子代理审查。
   - 审查清零后运行 `npm run review:receipt -- --record` 签发基于当前分支变更文件内容 SHA-256 指纹的收据（`.git/ester-review-receipt.json`）；任何一字节的代码修改都会立即使旧收据失效。
   - `npm run merge:main` 在合并回 `main` 前强制校验当前分支持有有效且未过期的复核收据。
4. **Layer 4 — 按风险分级的人工确认（Risk-Tiered Human Sign-off）**：
   - 复核通过后向用户清晰汇报功能点、测试结果与复核结论，获得用户明确确认后执行 `npm run merge:main -- <branch> --confirmed`。

---

## 2. 风险分级标准（Risk Tiers）

| 风险等级 | 判定路径 / 内容特征 | 审批与放行要求 |
| :--- | :--- | :--- |
| **Tier 0（低风险）** | 仅涉及文档（`docs/**`、非治理 `*.md`）、纯测试文件（`tests/**`）、注释调整 | 通过 `npm test` 后可直接签发收据并请用户确认合并 |
| **Tier 1（中风险）** | `src/**` 前端界面/建模/结果解析组件、常规非平台宿主逻辑或局部 Bug 修复 | **4 子代理并行审查 + 单测全绿**：无 `[Blocker]`/`[Important]`（Confidence `>= 80`）后签发收据 |
| **Tier 2（高风险）** | 1. Electron 主进程、Preload 与安全桥接（`desktop/main.cjs`、`desktop/preload.cjs`、`desktop/portable-*.cjs`）<br>2. 原生科学计算与外部引擎运行时契约（`desktop/*runtime*.cjs`、`desktop/*host*.cjs`、`desktop/chemistry/**`、`desktop/packaging/**`）<br>3. 远程/本地任务执行与进程监控（`desktop/task-system/**`）<br>4. 打包发布、上游同步与工程治理脚本（`scripts/release/**`、`scripts/upstream/**`、`scripts/workflow/**`、`AGENTS.md`、`REVIEW.md`、`package.json`） | **4 子代理并行深度审查 + 专项 Toolkit 核查 + 强制人工确认**：必须重点核查 macOS (`darwin-arm64` / `darwin-x64`) 与 Windows (`win32-x64`) 跨平台隔离及路径安全性 |

---

## 3. 全局必查失效模式（Global Failure Modes）

1. **违反 `ACTIVE_TASK.md` 范围边界或偏离用户意图 `[Blocker]`**：
   - 未实现 `ACTIVE_TASK.md` 中确认的核心功能点，或越界修改了声明为“非目标边界（Out of Scope）”的模块；
   - **审查者自身同样受此约束**：严禁子代理因未修改的其他文件、后续拆分分支待办项或脱离实际运行环境的极端理论假设而报告错误。
2. **macOS / Windows 跨平台兼容性破坏 `[Blocker]`**：
   - 在通用路径或 macOS 分支上硬编码 Windows 专属假设（如 `.exe`/`.dll`/`.cmd`、反斜杠路径 `\\`、`powershell`/`wsl`、Windows 保留设备名拦截未加 `platform === 'win32'` 守卫）；
   - 或在适配 macOS 时破坏了原有的 `win32-x64` 分支契约。
3. **上游同步合并时丢失我方 macOS 适配或漏适配新代码 `[Blocker]`**：
   - 在执行 `mac/upstream-*` 三方合并分支时，意外覆盖或回退了本仓库已完成的 macOS 适配逻辑；
   - 或未对上游新增代码中的平台相关调用（子进程、路径、原生依赖）补充 macOS 兼容处理。
4. **科学引擎与外部子进程安全/环境污染 `[Blocker]`**：
   - 调用内置 Python 引擎未使用 `-I`/`-S`/`-B` 隔离宿主机 `PYTHON*` 环境变量；
   - 子进程调用未使用参数数组（`spawn` / `execFile`），存在命令注入或路径穿越风险；
   - 吞掉异常（空 `catch {}`）导致静默失败且未返回结构化错误码。
5. **新增或修改代码缺少有效单元测试 `[Important]`**：
   - 修改 `src/**`、`desktop/**`、`scripts/**` 却未在 `tests/**` 中覆盖关键正常路径与边界/错误路径，或使用无意义的假断言。

---

## 4. 审查输出格式与降噪协议（Zero-Noise Protocol）

1. **强制证据引用（Hard Citations Only）**：
   - 每一条审查意见必须给出精确的 `文件路径:起始行-结束行` 以及具体的触发输入/边界条件。严禁发表无代码行佐证的“假设性担忧”。
2. **置信度评分过滤（Confidence Score `0..100`）**：
   - 仅报告置信度 **`>= 80`** 的问题；`< 80` 的主观风格偏好、假阳性或超出 `ACTIVE_TASK.md` 范围的猜测一律丢弃。
3. **四级标签分类**：
   - `[Blocker]`：逻辑缺陷、跨平台崩溃、安全隐患、丢失 macOS 适配或违反 `ACTIVE_TASK.md` 核心需求，必须修复。
   - `[Important]`：重要边界条件遗漏或测试覆盖缺失，应当修复。
   - `[Nit]`：局部可读性建议（非阻塞；若存在 `[Blocker]`/`[Important]` 则省略）。
   - `[Pre-existing]`：未修改代码行中的历史遗留问题，不阻塞当前分支。
4. **标准顶部汇总行**：
   - 审查报告第一行固定为：`Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier 0|1|2>`。
   - 若无任何需修复问题（`Blockers === 0 && Important === 0`），直接输出 `No actionable issues found.`。

---

## 5. 三轮修复熔断机制（3-Round Cap）

- 若围绕当前分支的审查与修复连续循环 **3 轮**（可通过 `npm run review:receipt -- --fail` 记录失败轮次）仍未清零 `[Blocker]` / `[Important]`，系统将触发熔断（`CIRCUIT_BREAKER_TRIGGERED`），必须立即停止自动修补并上报给用户，共同评估架构设计或拆分更小粒度的分支。
