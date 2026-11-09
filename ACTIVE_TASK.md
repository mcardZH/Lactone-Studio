# ACTIVE_TASK.md — 当前开发任务规格说明书 (Current Task Specification)

> **生命周期说明**：本文件仅记录**当前正在进行的单次开发任务**。当本分支完成开发、通过单元测试与代码独立复核并合并回 `main` 分支后，`npm run merge:main` 脚本会自动将本文件重置为空模板，以防历史记录无限累加膨胀。

---

## 1. 任务概述 (Task Overview)

- **任务名称**：移植多子代理 Code Review 插件替代 `review:codex`，并建立上游无 Git 历史源码快照跟踪与三方合并适配工作流
- **关联分支**：`feat/review-skills-and-upstream-sync`
- **当前状态**：`CONFIRMED`
- **核心目标**：
  1. 将 `AntifoulingMaterialsDatabase` 项目中的两个代码审查插件（`.agents/skills/code-review` 与 `.agents/skills/pr-review-toolkit`）及配套审查包/收据机制移植并本土化到本项目中，**正式替换原先的 `review:codex` 命令**，在 `merge:main` 合并前强制校验基于当前分支文件 SHA-256 指纹的多子代理复核收据（`review:receipt`）。
  2. 针对上游作者（`https://github.com/Ahey1/Ester-Studio`）仅发布无 `.git` 提交历史的源码压缩包（如 `v2.0.2` 与刚发布的 `v2.0.3`）的特点，建立**基于 `upstream/release` 合成演进分支的 Git 三方合并（3-Way Merge）与 macOS 增量适配工作流**（`scripts/upstream/upstream-sync.mjs` 与 `.agents/skills/upstream-sync/SKILL.md`）。

---

## 2. 需求细节与范围边界 (Requirements & Scope Boundary)

### 2.1 核心功能点 (In Scope)
- [x] **用多子代理 Code Review 工作流正式替代 `review:codex`**：
  - `.agents/skills/code-review/SKILL.md` 与 `references/subagent-prompts.md`：4 个并行 Fresh-Context `research` 子代理（规范与 `ACTIVE_TASK.md` 意图符合度审查员、深度逻辑与边界扫描员、调用链与历史契约审查员、安全与 macOS 跨平台卫生审查员）+ `0..100` 置信度过滤（仅报告 `>= 80`）+ 3 轮修复熔断 + SHA-256 收据签发。
  - `.agents/skills/pr-review-toolkit/SKILL.md` 与 `references/specialist-personas.md`：6 个专职审查子代理（`silent-failure-hunter`、`type-design-analyzer`、`pr-test-analyzer`、`comment-analyzer`、`code-reviewer`、`code-simplifier`），针对 Ester Studio 的 Electron/Node 宿主、Python 科学计算引擎、xTB/Multiwfn/OCR 运行时与 macOS 跨平台契约定制。
  - 新增 `REVIEW.md`（定义风险分级 `Tier 0 / Tier 1 / Tier 2`、macOS 跨平台红线、审查降噪协议与 3 轮熔断）。
  - 新增 `scripts/workflow/subagent-review.mjs` 并移除 `scripts/workflow/codex-review.mjs`：
    - `npm run review:prepare`：校验 `ACTIVE_TASK.md` 与单元测试，从基线读取 `REVIEW.md` 与 `ACTIVE_TASK.md`，生成自包含审查包 `.git/ester-review-packet.md`；
    - `npm run review:receipt`：计算分支相对于 `main` 所有变更文件的确定性内容 SHA-256 指纹，支持 `--record` 签发收据、`-f/--fail` 记录失败轮次（含 3 轮熔断）、`--verify` 校验收据有效性、`--clear` 清空状态；
    - 更新 `scripts/workflow/merge-to-main.mjs`：合并到 `main` 前强制校验当前分支持有有效且未过期的子代理复核收据（`verifyReviewReceipt`）。
- [x] **建立上游无历史源码快照跟踪与三方合并适配工作流**：
  - 新增 `scripts/upstream/upstream-sync.mjs` 与 `.agents/skills/upstream-sync/SKILL.md`，在 `package.json` 注册 `upstream:init`、`upstream:check`、`upstream:import`、`upstream:analyze`、`upstream:prepare-merge`：
    1. `upstream:init`：将仓库初始提交 `ab563fb`（或指定的基准提交）锚定为 `upstream/v2.0.2` 标签与 `upstream/release` 分支起点；
    2. `upstream:check`：查询 `https://api.github.com/repos/Ahey1/Ester-Studio/releases`，对比本地已有的 `upstream/v*` 标签，输出未同步的上游新版本（如 `v2.0.3`）、更新说明与 `source-code.zip` 下载信息；
    3. `upstream:import`：支持从本地解压目录或 `.zip` 归档（无需切换当前工作区分支）通过临时 `GIT_INDEX_FILE` + `git write-tree` + `git commit-tree` 将新版本源码快照直接提交到 `upstream/release` 分支并打标签 `upstream/vX.Y.Z`；
    4. `upstream:analyze`：以共同祖先 `upstream/v2.0.2` 为基准，对比 `upstream/vX.Y.Z` 与 `main`，输出《上游版本差异与 macOS 适配评估报告》（`.git/upstream-analysis-vX.Y.Z.md`），自动归类：
       - **分类 A（仅上游修改）**：我方未修改、可直接合入的文件；
       - **分类 B（双方共改 / 重叠文件）**：我方做过 macOS 适配且上游也修改的文件（需在三方合并时保护我方 macOS 逻辑）；
       - **分类 C（上游新增的平台敏感代码）**：扫描上游 Diff 新增行中的 `win32`、`.exe`/`.dll`/`.cmd`、`powershell`/`wsl`、路径分隔符硬编码、子进程调用或原生运行时锁变更，列出需补充 macOS 适配的具体文件与行号；
    5. `upstream:prepare-merge`：从 `main` 切出 `mac/upstream-vX.Y.Z` 分支，执行 `git merge --no-commit --no-ff upstream/vX.Y.Z` 三方合并，并将分类 B 与分类 C 清单自动生成到 `ACTIVE_TASK.md` 中。
- [x] **更新仓库治理文档**：
  - 同步更新 `AGENTS.md` 与 `CONTRIBUTING.md`，将第三步复核流程更新为多子代理复核（`review:prepare` + `code-review` / `pr-review-toolkit` + `review:receipt`），并补充上游版本同步工作流说明。

### 2.2 非目标边界 (Out of Scope)
- 本分支仅实现并验证多子代理 Code Review 工作流与上游跟踪/三方合并工具链；实际下载并合并上游 `v2.0.3` 源码包将在本分支合入 `main` 后，切出独立的 `mac/upstream-v2.0.3` 分支执行。

---

## 3. 技术设计方案 (Technical Design)

- **涉及模块与文件清单**：
  - `REVIEW.md`（新增）
  - `.agents/skills/code-review/SKILL.md`（新增）
  - `.agents/skills/code-review/references/subagent-prompts.md`（新增）
  - `.agents/skills/pr-review-toolkit/SKILL.md`（新增）
  - `.agents/skills/pr-review-toolkit/references/specialist-personas.md`（新增）
  - `.agents/skills/upstream-sync/SKILL.md`（新增）
  - `scripts/workflow/subagent-review.mjs`（新增，替代原 `codex-review.mjs`）
  - `scripts/workflow/codex-review.mjs`（删除）
  - `scripts/workflow/merge-to-main.mjs`（修改，校验 `verifyReviewReceipt` 并清理收据）
  - `scripts/upstream/upstream-sync.mjs`（新增）
  - `package.json`、`AGENTS.md`、`CONTRIBUTING.md`（修改）
- **跨平台兼容性考量 (macOS / Linux / Windows)**：
  - 使用 Node.js 原生 API 与 Git 底层 plumbing 命令（`git read-tree`, `git update-index`, `git write-tree`, `git commit-tree`），路径统一转换为 POSIX `/` 格式。

---

## 4. 自动化测试计划 (Automated Test Plan)

- **新增/修改测试文件**：
  - `tests/workflow/subagent-review.test.mjs`（替代原 `tests/workflow/codex-review.test.mjs`）
  - `tests/workflow/upstream-sync.test.mjs`（新增）
- **覆盖的核心场景与边界条件**：
  - [x] 验证 `ACTIVE_TASK.md` 校验与重置、`REVIEW.md` 风险分级计算、`prepareReviewPacket` 自包含审查包生成；
  - [x] 验证 `recordReviewReceipt`、`recordReviewFailure`（3 轮熔断机制）、文件修改后 SHA-256 状态指纹变化使旧收据自动失效，以及 `mergeBranchToMain` 拦截缺失/过期收据并在合并后自动重置 `ACTIVE_TASK.md`；
  - [x] 在隔离 Git 沙箱中验证 `upstream-sync.mjs` 全流程：`initUpstreamTracking` -> `importUpstreamSnapshot`（无工作区切换导入无 `.git` 目录的新版源码快照） -> `analyzeUpstreamDelta`（准确划分分类 A 仅上游修改、分类 B 双方共改重叠文件、分类 C 上游新增平台敏感代码行） -> `prepareUpstreamMergeBranch`（三方合并保留我方 macOS 改动并合入上游新功能）。

---

## 5. 用户沟通与意图确认记录 (User Intent Confirmation)

- **用户原始诉求**：
  1. 拷贝并适配 `AntifoulingMaterialsDatabase` 项目中的两个 Code Review 插件（`code-review` 和 `pr-review-toolkit`），用多子代理做复核方式，不再需要原先的 `review:codex` 命令。
  2. 建立跟踪上游无 Git 历史源码快照并执行三方合并的工作流（保留本仓 macOS 适配代码，同时识别并适配上游新增代码）；在本分支合入 `main` 后，紧接着开启新分支实际拉取并合并上游 `v2.0.3`。
- **用户是否已确认**：`CONFIRMED`
