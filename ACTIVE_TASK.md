# ACTIVE_TASK.md — 当前开发任务规格说明书

> **生命周期说明**：本文件仅记录当前活跃开发分支的任务需求、技术方案与用户意图确认结果。在当前分支通过测试与 `gpt-6.1-terra` 独立复核并合并到 `main` 后，自动化脚本会将本文件重置为空模板。

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段二（步骤 2/3）：macOS 任务中心远程 SSH/Slurm 环境与本机私钥路径适配 (`ssh-environment`)
- **关联分支**：`mac/phase2b-ssh-environment`
- **核心目标**：在保留 Windows 平台 `local`（Windows 本机）、`wsl`（WSL2）、`ssh`、`slurm` 全部功能与路径规则不变的前提下，在 macOS (`darwin`) 上仅开放远程 `ssh`（SSH 服务器）与 `slurm`（SSH + Slurm）执行环境、屏蔽不适用于 macOS 的 `local` 与 `wsl` 环境，并支持 macOS 本机 POSIX 绝对路径（`/Users/.../.ssh/id_ed25519`）作为 SSH 私钥文件路径 (`privateKeyPath`)。

## 2. 需求细节与范围边界 (Requirements & Scope)
- **核心功能点**：
  1. **后端环境与站点配置校验 (`desktop/task-system/environments.cjs`, `desktop/task-system/environment-profiles.cjs`)**：
     - `sanitizeEnvironment(input, { allowDraft = false, platform = process.platform } = {})`：
       - 当 `platform === "darwin"` 时，仅允许 `connectionKind === "ssh"`（包含 `schedulerKind: "none"` 与 `"slurm"`），若传入 `"local"` 或 `"wsl"` 则抛出 `ENVIRONMENT_INVALID`；
       - 当 `connectionKind === "ssh"` 且 `authentication === "private-key"` 时，根据客户端平台校验 `privateKeyPath`：`platform === "win32"` 时使用 `path.win32.isAbsolute`，非 Windows（如 `darwin`）时使用 `path.posix.isAbsolute`（同时拒绝相对路径与 Windows 盘符路径），校验未通过抛出 `PRIVATE_KEY_LOCAL_PATH_REQUIRED`；
     - `sanitizeSiteProfile(input, { allowDraft = false, platform = process.platform } = {})`：
       - 当 `platform === "darwin"` 时，仅允许 `site.connectionKind === "ssh"`，若传入 `"local"` 或 `"wsl"` 则抛出 `SITE_PROFILE_INVALID`。
  2. **前端环境助手与占位提示适配 (`src/web/task-system/environment-assistant.ts`)**：
     - 新增 `detectClientPlatform(explicitPlatform?: string)`、`isMacClientPlatform(explicitPlatform?: string)` 与 `availableEnvironmentPresets(platform?: string)`：在 macOS 下仅返回 `ssh` 与 `slurm` 预设；
     - 扩展 `environmentPathPlaceholder(environment, field, platform?: string)`：当 `field === "privateKeyPath"` 且在 macOS 下时返回 `"例如 /Users/your-user/.ssh/id_ed25519"`，在 Windows 下保持 `"例如 C:\\Users\\your-user\\.ssh\\id_ed25519"`。
  3. **前端环境设置表单适配 (`src/web/task-system/EnvironmentSettings.tsx`)**：
     - `newEnvironment(platform?: string)`：在 macOS 下默认创建 `connectionKind: "ssh"`、`displayName: "Gaussian · SSH服务器"` 的草稿；在 Windows 下保持默认 `connectionKind: "local"`、`displayName: "Gaussian · Windows 本机"`；
     - 新增并导出路径校验函数 `isValidEnvironmentPath(key, value, connectionKind, platform?: string)`：在 macOS 下对 `privateKeyPath` 校验 POSIX 绝对路径（以 `/` 开头），在 Windows 下保持盘符/UNC 路径校验；
     - 在 macOS 环境下的“环境类型”下拉框中仅展示 `SSH服务器` 与 `SSH + Slurm` 选项，隐藏 `Windows 本机` 与 `WSL2`。
- **非目标边界 (Out of Scope)**：
  - 本分支仅修改 `desktop/task-system/environments.cjs`、`desktop/task-system/environment-profiles.cjs`、`src/web/task-system/environment-assistant.ts`、`src/web/task-system/EnvironmentSettings.tsx` 及对应单元测试文件。
  - 不修改 SSH 传输层 (`desktop/task-system/execution/ssh-transport.cjs`)、Slurm 控制器 (`desktop/task-system/execution/slurm.cjs`) 或本地任务运行器 (`desktop/task-system/execution/runner.cjs`)。
  - MolVec 离线化学结构图片识别 (OCR) 将在阶段二的微分支 2C (`mac/phase2c-molvec-ocr`) 中独立推进。

## 3. 技术设计方案 (Technical Design)
- **涉及文件清单**：
  - `desktop/task-system/environments.cjs`
  - `desktop/task-system/environment-profiles.cjs`
  - `src/web/task-system/environment-assistant.ts`
  - `src/web/task-system/EnvironmentSettings.tsx`
  - `tests/desktop/task-system/environments.test.mjs`
  - `tests/web/task-system/environment-settings.test.ts`
- **跨平台兼容性考量 (macOS / Linux / Windows)**：
  - 所有改动均支持显式传入 `platform` 参数（默认自动检测当前运行平台），确保在 macOS 与 Windows 上均可确定性地执行双平台单元测试。
  - Windows (`win32`) 下的默认环境类型、路径校验与预设列表 100% 保持原有行为不变。

## 4. 自动化测试计划 (Automated Test Plan)
- **测试文件路径**：
  - `tests/desktop/task-system/environments.test.mjs`
  - `tests/web/task-system/environment-settings.test.ts`
- **覆盖场景与边界条件**：
  1. `sanitizeEnvironment` 与 `sanitizeSiteProfile` 在 `darwin` 与 `win32` 平台下的连接类型白名单校验（`darwin` 拒绝 `local`/`wsl`，接受 `ssh`/`slurm`；`win32` 接受 `local`/`wsl`/`ssh`/`slurm`）；
  2. `sanitizeEnvironment` 在 `darwin` 与 `win32` 下对 `privateKeyPath` 的本机绝对路径校验（`darwin` 接受 `/Users/.../.ssh/id_ed25519` 并拒绝 `C:\...` 与相对路径；`win32` 接受 `C:\...` 并拒绝相对路径）；
  3. 前端 `detectClientPlatform`、`isMacClientPlatform`、`availableEnvironmentPresets`、`environmentPathPlaceholder`、`newEnvironment`、`environmentDraftForMode` 与 `isValidEnvironmentPath` 在 `darwin` 和 `win32` 下的完整单元测试。

## 5. 用户沟通与意图确认记录 (User Intent Confirmation)
- **原始诉求**：macOS 不需要本地运行 ORCA 或 Gaussian，只需屏蔽本地计算环境（`local` / `wsl`）并确保远程计算环境（`ssh` / `slurm`）在 macOS 上完整可用，按阶段二微分支顺序推进。
- **澄清问题与结论**：已与用户确认在 macOS 上屏蔽 `local` 与 `wsl` 环境，仅保留 `ssh` 与 `slurm`，并支持 macOS 本机 POSIX 私钥路径。
- **用户确认状态**：已确认
