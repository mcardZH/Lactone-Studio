# AGENTS.md — Ester Studio (macOS Adaptation & Cross-Platform Repository)

本文件为所有在此仓库工作的 AI 智能体（如 **Antigravity**、**Codex** 等）及开发者提供项目架构导航、开发规范、分支隔离约束、自动化测试要求以及合并前的代码审核宪章。所有参与开发的 Agent 必须严格遵守本文件规定的工作流。

---

## 1. 项目概览 (Project Overview)

**Ester Studio (ES)**（原名 SY-Studio / SciYue Input Studio，当前基线版本 `v2.0.2`）是一款面向计算化学与分子模拟工作流的一体化桌面软件，采用 **Electron 44.7.0 + React 19 + TypeScript + Python 科学计算引擎** 架构。

当前仓库的核心目标是在保留完整科学计算能力与跨平台兼容性的前提下，将原 `win32-x64` 锁定的发布源码改造并打包为**可在 macOS（Apple Silicon `darwin-arm64` 及 Intel `darwin-x64`）上原生运行的软件**。

更多详细文档请参阅：
- [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)：完整的目录与模块职责拆解、进程间通信（IPC）与数据流说明。
- [docs/MACOS_PORTING_ROADMAP.md](docs/MACOS_PORTING_ROADMAP.md)：macOS 平台兼容性评估、Windows/Linux 平台专属边界及分阶段改造与打包路线图。
- [CONTRIBUTING.md](CONTRIBUTING.md)：分支开发、测试编写、Git Hooks 安装与 Codex 审核实操指南。
- [BUILDING.md](BUILDING.md)：原始 v2.0.2 源码快照构建说明。

---

## 2. 仓库核心目录结构 (Repository Structure Summary)

```text
Ester-Studio-v2.0.2-source-code/
├── AGENTS.md                        # AI 智能体开发宪章与核心工作流规范（本文件）
├── CONTRIBUTING.md                  # 开发者与智能体贡献指南
├── docs/                            # 架构说明与 macOS 改造路线图文档
│   ├── PROJECT_STRUCTURE.md         # 详细代码结构与模块说明
│   └── MACOS_PORTING_ROADMAP.md     # macOS 移植评估与分阶段打包方案
├── src/                             # 前端渲染进程代码 (React 19 + TypeScript + Vite)
│   ├── core/                        # 核心数据结构、元素周期表、单位换算、结构库溯源
│   ├── web/                         # Web/工作台主界面组件、状态管理与交互视图
│   ├── modeling/                    # 3D 分子/晶体建模、约束、高级构象/路径/动力学配置
│   ├── results/                     # 量化输出解析、轨迹播放、光谱 (IR/Raman/UV-Vis/NMR) 渲染
│   ├── task-system/                 # 任务中心协议、状态读取与前端视图模型
│   ├── projects/                    # .es / .sy 工程文件读写与快照序列化
│   └── citations/                   # 计算方法学文献引用自动收集与导出
├── desktop/                         # Electron 主进程、Preload 与本地运行时宿主
│   ├── main.cjs                     # Electron 主进程入口与 IPC 路由注册
│   ├── preload.cjs                  # 渲染进程安全桥接层 (Context Bridge)
│   ├── runtime.cjs                  # Python 科学引擎启动器解析 (支持 SCIYUE_PYTHON)
│   ├── current-runtime.cjs          # 原生运行时完整性与平台校验
│   ├── xtb-runtime.cjs / xtb-host.cjs / aiss-host.cjs  # xTB 半经验计算与 aISS 对接宿主
│   ├── orbital-runtime.cjs          # Multiwfn 波函数与分子轨道分析宿主
│   ├── ocr-runtime.cjs / ocr/       # MolVec Java 离线化学结构图片识别 (OCR)
│   ├── chemistry/                   # Python 科学计算引擎 (RDKit, ASE, Spglib, tblite, SciPy)
│   └── task-system/                 # 本地/WSL/SSH 远程任务执行、Slurm 调度与进程监控
├── scripts/                         # 构建准备脚本与开发工作流自动化脚本
│   └── workflow/                    # 分支策略、测试运行器、Git Hooks 与 Codex 审核脚本
├── .githooks/                       # 受版本控制的 Git 提交与合并钩子（面向常规开发流程护栏）
│   ├── pre-commit                   # 禁止在 main 直接提交、校验代码测试覆盖并运行测试
│   └── pre-merge-commit             # 拦截未通过测试/未通过 Codex 审核/未经用户确认的常规合并
├── tests/                           # 自动化测试用例目录 (node:test + Vitest)
├── public/                          # 静态资源、内置分子/晶体结构库与渲染预览图
├── third-party/                     # 第三方运行时构建配方与源码索引
└── licenses/                        # 开源许可证与组件合规声明
```

---

## 3. 强制开发工作流与分支保护规范 (Mandatory Development Workflow)

为了保护主分支（`main`）始终处于稳定、可构建、已验证状态，所有开发工作必须严格遵循以下**铁律**，并由 `.githooks/` 钩子在 Git 层面强制执行：

### 3.1 严禁在主分支 (`main`) 直接开发或提交
1. **主分支只接受合并（Merge），不接受直接开发提交**。
2. 任何新功能、macOS 平台适配、Bug 修复、脚本重构或文档更新，**必须先从 `main` 切出独立的新分支**进行开发：
   - macOS 平台适配分支：`mac/<module-or-feature>`（例如 `mac/process-identity-darwin`、`mac/xtb-runtime`）
   - 新功能分支：`feat/<feature-name>`
   - 缺陷修复分支：`fix/<issue-name>`
   - 工程/文档维护分支：`chore/<task-name>` 或 `docs/<topic>`
3. `.githooks/pre-commit` 与 `.githooks/pre-merge-commit` 作为**面向常规开发与合并流程的工程护栏**，会在本地自动检查当前分支、测试覆盖与审核凭证（注：本地钩子旨在规范常规 `git commit` 与 `git merge` 操作，无需针对极端或对抗性的 Git 底层命令绕过方式做过度防御）。

### 3.2 新代码与新功能必须配备自动化测试用例
1. **无测试不合并**：凡是涉及新增代码、新增功能、修改现有业务逻辑或跨平台适配（包括 `src/**`、`desktop/**`、`scripts/**`），**必须同步在 `tests/**` 目录下新增或更新对应的自动化测试用例**（命名为 `tests/**/*.test.{mjs,cjs,js,ts,tsx}`，由 `npm test` 自动按文件类型调度 Node.js 内置 `node:test` 与项目内置 `Vitest` 运行器执行）。
2. 测试用例应覆盖新增代码的核心正常路径（Happy Path）、常规边界条件以及平台分支逻辑（如 `darwin` vs `win32` vs `linux`）。
3. 每次提交前及合并前必须运行 `npm test`，确保**所有测试用例 100% 通过（无失败、无跳过）**。

---

## 4. 合并前 Codex (`gpt-6.1-terra`) 子代理代码审核机制

在功能分支开发完成且本地 `npm test` 全部通过后，**严禁直接合并到 `main`**。必须先使用 `codex` 命令行启动 `gpt-6.1-terra` 模型的子代理对当前分支相对于 `main` 的变更进行独立代码审核：

```bash
npm run review:codex
```
（底层执行 `node scripts/workflow/codex-review.mjs`，内部调用 `codex exec -m gpt-6.1-terra ...` 对分支 Diff、测试覆盖率、代码逻辑与需求符合度进行结构化审查，并生成 `.git/codex-review-receipt.json` 审核凭证）。

### 审核结果的处理分为以下两种情况：

#### 情况 1：审核出现错误 (`FAIL`)
触发条件包括但不限于：**测试失败、代码逻辑缺陷、关键测试覆盖不到位、存在安全/跨平台隐患、或功能不符合用户要求**。
1. **立即提示用户**当前审核发现的具体问题清单。
2. 由 **Antigravity（主代理）** 在当前开发分支上针对审核意见继续进行代码或测试修复。
3. 修复完成后，重新提交并**重新运行测试 (`npm test`) 与 Codex 审核 (`npm run review:codex`)**。
4. **最多重复 3 次审核与修复循环（Circuit Breaker）**：
   - 若连续经过 **3 次**“审核 -> 修复 -> 重测 -> 重审”后仍然失败，Antigravity **必须立即停止自动修复循环**；
   - 明确告知用户：**“已连续 3 次审核与修复未通过，请仔细思考当前项目架构设计，评估是否一次性改动过大，建议拆分为更小粒度的分支后再推进。”**

#### 情况 2：审核通过且测试通过 (`PASS`)
当 `npm test` 全部通过，且 Codex (`gpt-6.1-terra`) 审核结论为 `PASS` 时：
1. Antigravity 用**清晰、结构化的语言**向用户汇报：
   - **本次新增/修改的功能与变更范围**；
   - **新增的测试用例与测试执行结果**；
   - **Codex (`gpt-6.1-terra`) 子代理的代码审核结论与评价摘要**。
2. **等待用户明确确认**：
   - 在收到用户的明确许可前，**绝对不能**执行合并到 `main` 的操作。
   - 用户确认后，方可执行合并命令将分支合并回 `main`：
     ```bash
     npm run merge:main -- <branch-name> --confirmed
     ```
     （或在主分支执行 `USER_CONFIRMED_MERGE=1 git merge --no-ff <branch-name>`）。

---

## 5. 常用开发与验证命令速查

| 命令 | 说明 |
| :--- | :--- |
| `npm run hooks:install` | 配置 Git 使用仓库内置的 `.githooks` 目录并设置执行权限 |
| `npm test` | 运行仓库自动化测试套件（强制要求存在测试用例且全部通过） |
| `npm run check:branch` | 检查当前分支是否符合分支隔离与新增代码测试覆盖策略 |
| `npm run review:codex` | 启动 Codex CLI (`gpt-6.1-terra`) 子代理执行合并前代码审核（含 3 次熔断计数） |
| `npm run merge:main -- <branch> --confirmed` | 在测试通过、Codex 审核通过且用户确认后，安全合并指定分支到 `main` |
| `npm run dev` | 启动前端 Vite 开发服务器 |
| `npm run desktop:dev` | 启动 Electron 桌面端开发环境 |
| `npm run build` | 执行 TypeScript 类型检查与前端生产构建 |
