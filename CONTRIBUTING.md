# 贡献指南 (Contributing Guide)

欢迎参与 **Ester Studio (ES)** 的开发与 macOS 跨平台适配！为了保证代码质量、科学计算准确性以及主分支（`main`）的稳定性，所有人类开发者与 AI 智能体（Antigravity / Codex）均须遵循本指南。

---

## 1. 环境初始化

克隆或进入仓库后，首先安装并激活受版本控制的 Git Hooks：

```bash
npm run hooks:install
```

这会将当前 Git 仓库的 `core.hooksPath` 指向 `.githooks/`，启用以下面向常规开发流程的自动检查：
- **`pre-commit`**：禁止在 `main` 分支直接提交；当变更包含代码文件时检查 `tests/` 下是否包含测试文件变更，并自动运行测试套件。
- **`pre-merge-commit`**：在常规合并到 `main` 时，校验测试结果、`gpt-6.1-terra` 代码审核通过凭证（`.git/codex-review-receipt.json`）以及用户明确确认标记（`USER_CONFIRMED_MERGE=1`）。

---

## 2. 标准开发流程

### 第一步：从 `main` 创建功能分支

**严禁直接在 `main` 分支修改代码或提交**。始终从最新的 `main` 分支切出语义化分支：

```bash
git checkout main
git checkout -b mac/your-feature-name
```

推荐分支命名前缀：
- `mac/*`：macOS 平台适配、运行时解锁与 `.app` 打包相关改动
- `feat/*`：新增业务功能
- `fix/*`：Bug 修复
- `chore/*` 或 `docs/*`：工程工具链、脚本或文档维护

### 第二步：编写代码与配套测试用例

1. **新功能/新代码必须有测试覆盖**：
   - 修改或新增 `src/**`、`desktop/**`、`scripts/**` 中的代码时，必须在 `tests/` 目录下同步新增或更新测试用例（Node 主进程与工作流脚本使用 `*.test.{mjs,cjs,js}` 跑 `node:test`，前端 `src/` TypeScript/TSX 组件使用 `*.test.{ts,tsx}` 跑 `Vitest`）。
   - 跨平台改造代码应当同时测试 `darwin`（macOS）、`win32`（Windows）与 `linux` 下的行为分支。
2. **保持小步提交**：
   - 避免一次性在单个分支中堆叠过多互不相关的模块改动，以便于测试定位和代码审核。

### 第三步：运行本地自动化测试

在提交或发起审核前运行：

```bash
npm test
npm run check:branch
```

确保所有测试用例 100% 通过。

### 第四步：执行 Codex (`gpt-6.1-terra`) 子代理代码审核

在工作区干净（所有更改已提交到当前分支）后，运行：

```bash
npm run review:codex
```

该命令将调用 `codex exec -m gpt-6.1-terra` 对当前分支相对于 `main` 的全部提交、代码逻辑、测试覆盖度和潜在风险进行审查：

- **情况 1（审核未通过 `FAIL`）**：
  - 提示用户审核发现的问题（如测试失败、逻辑漏洞、关键路径缺少测试、不符合需求等）。
  - 由 Antigravity 进行修复，修复后重新提交并再次执行 `npm test` 与 `npm run review:codex`。
  - **最多重复 3 次审核与修复循环**：若连续 3 次审核仍未通过，停止自动修复并提醒用户重新审视项目架构，评估是否单次改动过大。
- **情况 2（审核通过 `PASS` 且测试通过）**：
  - 向用户清晰汇报本次新增功能、测试结果与审核结论。
  - **等待用户明确确认后**，进入第五步合并。

### 第五步：用户确认后合并至 `main`

收到用户明确确认后，执行：

```bash
npm run merge:main -- <branch-name> --confirmed
```

该脚本将切换至 `main` 分支，带上 `USER_CONFIRMED_MERGE=1` 标记并以 `--no-ff` 模式完成受保护合并。
