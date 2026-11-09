# AGENTS.md — Lactone Studio (Unofficial Modified Version of Ester Studio · macOS & Cross-Platform Repository)

本文件为所有在此仓库工作的 AI 智能体（如 **Antigravity**、**Codex** 等）及开发者提供项目架构导航、开发规范、分支隔离约束、自动化测试要求以及合并前的代码审核宪章。所有参与开发的 Agent 必须严格遵守本文件规定的工作流。

---

## 1. 项目概览 (Project Overview)

**Lactone Studio (LS)** 是基于 **Ester Studio (ES)**（原名 SY-Studio / SciYue Input Studio，当前上游基线版本 `v2.0.3`，原作者 Zixuan Zhang）改造的**非官方修改版（Unofficial Modified Version）**，是一款面向计算化学与分子模拟工作流的一体化桌面软件，采用 **Electron 44.7.0 + React 19 + TypeScript + Python 科学计算引擎** 架构。

当前仓库（`https://github.com/mcardZH/Lactone-Studio`）的核心目标是在保留完整科学计算能力、遵守 `LICENSE.txt` 开源协议（第七条非官方修改版标识与第八条科研引用规范）与跨平台兼容性的前提下，将原 `win32-x64` 锁定的发布源码改造并打包为**可在 macOS（Apple Silicon `darwin-arm64` 及 Intel `darwin-x64`）上原生运行的软件**，并提供人机同屏协作 MCP 服务。

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
├── ACTIVE_TASK.md                   # 当前开发任务规格说明书（需求、方案与用户意图确认，合并后自动清空）
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
│   └── workflow/                    # 分支策略、测试运行器、Git Hooks、任务规范与 Codex 审核脚本
├── .githooks/                       # 受版本控制的 Git 提交与合并钩子（面向常规开发流程护栏）
│   ├── pre-commit                   # 禁止在 main 直接提交、校验代码测试覆盖并运行测试
│   └── pre-merge-commit             # 拦截未通过测试/未经用户确认的常规合并
├── tests/                           # 自动化测试用例目录 (node:test + Vitest)
├── public/                          # 静态资源、内置分子/晶体结构库与渲染预览图
├── third-party/                     # 第三方运行时构建配方与源码索引
└── licenses/                        # 开源许可证与组件合规声明
```

---

## 3. 强制 AI 规范化开发三步走流程 (Mandatory 3-Step AI Workflow)

当 AI 智能体接到任何新的开发任务（包括 macOS 适配、新特性、Bug 修复或重构）后，**必须严格按照以下三步流程推进**：

### 步骤 1：记录需求与确认意图 (`ACTIVE_TASK.md`)
1. **建立任务规格说明书**：
   AI 必须首先在项目根目录的 [ACTIVE_TASK.md](ACTIVE_TASK.md) 文件中记录本次要开发的内容。
2. **规范模板要求**：
   必须严格遵循 `ACTIVE_TASK.md` 规定的标准模板编写，模板包含以下核心内容：
   - **任务概述**：任务名称、关联分支名、核心目标概要；
   - **需求细节与范围边界**：核心功能点、非目标边界（Out of Scope，明确本次不做哪些以防过度扩散）；
   - **技术设计方案**：涉及文件清单、跨平台兼容性考量（macOS/Linux/Windows）、关键实现逻辑；
   - **自动化测试计划**：测试文件路径、覆盖的核心场景与边界条件；
   - **用户沟通与意图确认记录**：用户原始诉求要点、澄清的问题与最终共识结论。
3. **与用户深入讨论并确认**：
   AI 必须就上述需求与技术方案与用户进行充分沟通，确保对用户意图理解准确、无任何误解或主观推测；将沟通澄清的结论完整记入该文件中，并获得用户明确确认后，方可进入编码阶段。

### 步骤 2：完成开发与硬性单元测试
1. **独立分支开发**：
   **严禁在 `main` 分支直接提交或开发**。从 `main` 切出对应命名的独立分支（macOS 适配：`mac/*`、新功能：`feat/*`、修复：`fix/*`、工程维护：`chore/*`）。
2. **编写代码与配套单元测试**：
   - 遵循“无测试不提交”原则：新增或修改代码（`src/**`, `desktop/**`, `scripts/**`）时，必须同步在 `tests/**` 编写或更新对应的自动化测试用例；
   - Node 主进程与脚本测试使用原生 `node:test`（`*.test.{mjs,cjs,js}`），前端 TypeScript 组件测试使用 `Vitest`（`*.test.{ts,tsx}`）。
3. **硬性单元测试检验**：
   - 提交前及发起复核前必须执行 `npm test`；
   - 硬性要求：**所有单元测试 100% 绿色通过（0 失败、0 跳过）**。

### 步骤 3：独立上下文多子代理复核 (`code-review` / `pr-review-toolkit`) 与循环修改
在完成开发且单元测试全部通过后，在提交 PR 或合并到 `main` 之前，必须使用 `.agents/skills/code-review`（及按需使用 `.agents/skills/pr-review-toolkit`）执行独立上下文多子代理代码复核：

```bash
npm run review:prepare
```

1. **自包含审查包与严格范围边界**：
   - `npm run review:prepare` 会验证 `ACTIVE_TASK.md` 与单元测试，并读取 `ACTIVE_TASK.md`、`REVIEW.md` 及当前分支相对于 `main` 的代码 Diff，生成 `.git/ester-review-packet.md`；
   - 启动 4 个并行 `research` 子代理（详见 `.agents/skills/code-review/SKILL.md`）对代码进行独立盲审，按 `0..100` 置信度评分过滤（仅报告 `>= 80` 的 `[Blocker]` 与 `[Important]`）；
   - **严格聚焦修改部分（严禁无限扩大范围）**：复核仅针对本分支实际修改的代码逻辑与 `ACTIVE_TASK.md` 声明的本阶段目标；严格尊重 `ACTIVE_TASK.md` 中定义的“非目标边界（Out of Scope）”。
2. **复核收据签发与 3 次熔断机制**：
   - **审核未通过 (`FAIL`)**：运行 `npm run review:receipt -- --fail` 记录失败轮次，由主 Agent 修复问题后重新运行测试与复核；
   - **3 次熔断机制（Circuit Breaker）**：若连续 3 次“审核 -> 修复 -> 重审”后依然未通过，系统触发熔断并停止自动修复，立即反馈给人工处理；
   - **审核通过 (`PASS`)**：运行 `npm run review:receipt -- --record --summary "Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: <Tier>"` 签发基于当前分支文件内容 SHA-256 指纹的收据，向用户清晰汇报本次新增功能、测试结果与复核结论，**等待用户明确确认**后执行 `npm run merge:main -- <branch> --confirmed`。

---

## 3.5 上游无 Git 历史源码快照跟踪与三方合并工作流 (`upstream-sync`)

针对上游官方仓库（`https://github.com/Ahey1/Ester-Studio/releases`）仅发布 `source-code.zip` 源码压缩包而不包含日常 Git 历史的特点，仓库维护了一条以初始 `v2.0.2` 快照（`ab563fb`）为起点的合成上游分支 `upstream/release`（详见 `.agents/skills/upstream-sync/SKILL.md`）：
1. `npm run upstream:check`：检查上游 GitHub Releases 是否有未同步的新版本；
2. `npm run upstream:import -- --version vX.Y.Z --source <path>`：将新版本源码包无损导入 `upstream/release` 分支并打标签 `upstream/vX.Y.Z`；
3. `npm run upstream:analyze -- --version vX.Y.Z`：以共同祖先执行三方差异分析，自动列出 **分类 A（仅上游修改）**、**分类 B（与我方 macOS 适配共改重叠文件）** 与 **分类 C（上游新增的平台敏感代码行）**；
4. `npm run upstream:prepare-merge -- --version vX.Y.Z`：切出 `mac/upstream-vX.Y.Z` 分支执行三方合并，确保既保留我方全部 macOS 适配，又对上游新增代码完成 macOS 适配与测试。

---

## 4. 生命周期管理与文档防膨胀机制

为了防止开发记录文件无限累加膨胀：
- **`ACTIVE_TASK.md` 仅服务于单次开发任务**；
- 在分支合并至 `main` 分支（或提交 PR）后，合并自动化脚本（`npm run merge:main`）会**自动将 `ACTIVE_TASK.md` 清空并重置为初始空模板**，并自动创建提交或保持整洁状态；
- 下一个开发任务切出新分支时，将从全新的空模板开始记录，确保历史记录不冗余、意图聚焦无污染。

---

## 5. 常用开发与验证命令速查

| 命令 | 说明 |
| :--- | :--- |
| `npm run hooks:install` | 配置 Git 使用仓库内置的 `.githooks` 目录并设置执行权限 |
| `npm test` | 运行仓库硬性单元测试套件（强制要求存在测试用例且全部通过） |
| `npm run check:branch` | 检查当前分支是否符合分支隔离与新增代码测试覆盖策略 |
| `npm run review:prepare` | 校验 `ACTIVE_TASK.md` 与单测，生成供多子代理 (`code-review` / `pr-review-toolkit`) 使用的 `.git/ester-review-packet.md` |
| `npm run review:receipt -- --record` | 多子代理复核清零后，签发基于当前分支内容 SHA-256 指纹的复核收据 |
| `npm run upstream:check` | 检查上游 `Ahey1/Ester-Studio` GitHub Releases 是否有未同步的新版源码包 |
| `npm run upstream:import -- --version <v> --source <p>` | 将上游新版源码包导入 `upstream/release` 分支并打标签 `upstream/<v>` |
| `npm run upstream:analyze -- --version <v>` | 生成上游新版与本仓 `main` 的三方差异及新增平台敏感代码评估报告 |
| `npm run upstream:prepare-merge -- --version <v>` | 切出 `mac/upstream-<v>` 分支并启动 Git 三方合并与 `ACTIVE_TASK.md` 初始化 |
| `npm run merge:main -- <branch> --confirmed` | 校验单测与子代理复核收据通过且用户确认后，安全合并指定分支到 `main` 并自动清空 `ACTIVE_TASK.md` |
| `npm run dev` | 启动前端 Vite 开发服务器 |
| `npm run desktop:dev` | 启动 Electron 桌面端开发环境 |
| `npm run build` | 执行 TypeScript 类型检查与前端生产构建 |
