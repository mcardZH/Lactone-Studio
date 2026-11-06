# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：规范化 AI 开发流程与基于 ACTIVE_TASK.md 的独立代码复核机制
- **关联分支**：feat/task-spec-and-review-workflow
- **目标概要**：在 AGENTS.md 中确立 AI 任务开发闭环（意图确认 -> 开发测试 -> 独立复核），实现读取 ACTIVE_TASK.md 复核、3 次循环熔断与合并后自动重置。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. 确立 `ACTIVE_TASK.md` 规范与标准模板，支持自动验证是否有效填写与合并后自动清空；
  2. 更新 `AGENTS.md` 与 `CONTRIBUTING.md`，明确 AI 接收任务后的 3 步规范（意图对齐、开发测试、独立复核）；
  3. 实现 `scripts/workflow/codex-review.mjs`，复核时读取 `ACTIVE_TASK.md` 内容比对 Git Diff，并提供 3 次循环修复熔断逻辑；
  4. 在 `scripts/workflow/merge-to-main.mjs` 中接入合并后自动清空重置 `ACTIVE_TASK.md`；
  5. 配套完整的单元测试与集成测试，确保硬性测试 100% 自动通过。
- **边界与非目标 (Out of Scope)**：
  - 本次任务不修改科学计算业务逻辑（`src/**`, `desktop/chemistry/**`），仅聚焦工程与工作流治理机制。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `ACTIVE_TASK.md`
  - `AGENTS.md`
  - `CONTRIBUTING.md`
  - `package.json`
  - `scripts/workflow/active-task.mjs`
  - `scripts/workflow/codex-review.mjs`
  - `scripts/workflow/merge-to-main.mjs`
  - `tests/workflow/codex-review.test.mjs`
  - `tests/workflow/git-hooks-integration.test.mjs`
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 使用跨平台路径处理（Node `path.join`, 正斜杠规范化）；
  - 保证在 macOS 与 Linux/Windows 环境下无差异执行。
- **关键实现逻辑与架构影响**：
  - 复核器调用逻辑：读取 `ACTIVE_TASK.md`，拼装 Prompt 与 Git Diff，调用 `codex exec -m gpt-6.1-terra`（或支持测试沙箱 mock）；
  - 状态持久化：使用 `.git/codex-review-state.json` 记录尝试次数，第 3 次失败提示人工介入；
  - 自动重置：`mergeBranchToMain` 执行成功后自动调用 `resetActiveTask` 并提交干净模板。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/workflow/codex-review.test.mjs`
  - `tests/workflow/git-hooks-integration.test.mjs`
- **核心验证场景与边界条件**：
  - `ACTIVE_TASK.md` 未填写或缺失时复核被拦截；
  - 复核器成功读取 `ACTIVE_TASK.md` 意图与需求注入 Prompt；
  - 3 次失败熔断机制；
  - 分支合并后 `ACTIVE_TASK.md` 自动重置为初始空模板。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 在 AGENTS.md 中明确新任务流程：
    1. 记录需求与确认意图：AI 首先在专门文件记下开发内容并提供模板，与用户讨论确保无误；
    2. 完成开发与单元测试：跑完单元测试后触发独立复核；
    3. 独立复核与循环修改：读取该文件内容检查 Git 提交代码，最多重复 3 次后转人工；
    4. 文件防止膨胀：只记录本次开发，提交 PR/合并后自动清空留给下次使用。
- **澄清细节与确认结论**：
  - 文件命名选用语义明确的 `ACTIVE_TASK.md`；
  - 流程严格按照用户提出的 1、2、3 步与自动清空要求落地。
- **是否已获得用户开发确认**：是
