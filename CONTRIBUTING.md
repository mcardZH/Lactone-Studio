# 贡献指南 (Contributing Guide)

欢迎参与 **Ester Studio (ES)** 的开发与 macOS 跨平台适配！为了保证代码质量、科学计算准确性以及主分支（`main`）的稳定性，所有人类开发者与 AI 智能体（Antigravity / Codex）均须遵循本指南。

---

## 1. 环境初始化

克隆或进入仓库后，首先安装并激活受版本控制的 Git Hooks：

```bash
npm run hooks:install
```

这会将当前 Git 仓库的 `core.hooksPath` 指向 `.githooks/`，启用以下自动保护检查：
- **`pre-commit`**：禁止在 `main` 分支直接提交；检查代码变更是否具备自动化测试用例覆盖，并自动执行硬性单元测试套件。
- **`pre-merge-commit`**：在合并到 `main` 时，硬性要求单元测试全部通过。

---

## 2. AI 规范化开发三步走流程

### 第一步：记录需求与确认意图 (`ACTIVE_TASK.md`)

AI 智能体接到任何新任务后，**必须先在根目录 [ACTIVE_TASK.md](ACTIVE_TASK.md) 中填写任务规格说明书**：
1. 按照模板填写：任务概述、需求细节与范围边界（含 Out of Scope）、技术方案、测试计划；
2. **与用户深入沟通讨论**：明确需求细节，防止理解偏差或主观推测；将澄清结论记入“用户沟通与意图确认记录”章节并获得确认。

### 第二步：从 `main` 切分支，完成开发与单元测试

1. **分支规范**：
   始终从最新的 `main` 分支切出语义化分支：
   ```bash
   git checkout main
   git checkout -b mac/your-feature-name   # macOS 适配
   # 或 feat/xxx (新特性), fix/xxx (修复), chore/xxx (维护)
   ```
2. **编写代码与测试**：
   凡修改 `src/**`、`desktop/**`、`scripts/**`，必须在 `tests/**` 同步增加或更新测试。
3. **本地运行硬性单元测试**：
   ```bash
   npm test
   npm run check:branch
   ```
   确保所有测试用例 100% 绿色通过。

### 第三步：基于 `ACTIVE_TASK.md` 与 `REVIEW.md` 触发多子代理复核

在提交 PR 或合并前，生成自包含审查包并运行 `.agents/skills/code-review`（或 `pr-review-toolkit`）多子代理复核：

```bash
npm run review:prepare
```

1. 4 个并行 Fresh-Context `research` 子代理将**读取 `.git/ester-review-packet.md` 中的 `ACTIVE_TASK.md` 与 `REVIEW.md`**，审查当前 Git Diff 是否完整契合需求、是否存在代码缺陷、安全性风险或 macOS 跨平台兼容性问题。
2. **循环修改、3 次熔断与收据签发**：
   - 若发现置信度 `>= 80` 的 `[Blocker]` / `[Important]` 问题，运行 `npm run review:receipt -- --fail` 记录失败轮次并由主 Agent 修复（连续 3 次未通过触发熔断）；
   - 若复核清零通过，签发基于当前分支内容 SHA-256 指纹的收据：
     ```bash
     npm run review:receipt -- --record --summary "Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: <Tier>"
     ```
3. **用户确认后合并**：
   复核通过后向用户汇报；收到用户明确确认后，执行合并：
   ```bash
   npm run merge:main -- <branch-name> --confirmed
   ```

---

## 3. 文档生命周期与自动防膨胀

- `ACTIVE_TASK.md` 仅用于记录本次任务内容，不作历史累加；
- 执行 `npm run merge:main -- <branch> --confirmed` 合并后，脚本会**自动将 `ACTIVE_TASK.md` 清空并重置为初始空模板**并自动提交，供下一次任务切分支时使用。
