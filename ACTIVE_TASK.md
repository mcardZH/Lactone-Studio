# ACTIVE_TASK.md — 当前开发任务规格说明书

> **生命周期说明**：本文件仅记录当前活跃开发分支的任务需求、技术方案与用户意图确认结果。在当前分支通过测试与 `gpt-6.1-terra` 独立复核并合并到 `main` 后，自动化脚本会将本文件重置为空模板。

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段一（步骤 4/4）：轻量级 macOS / POSIX 任务宿主进程身份探针 (`process-identity`)
- **关联分支**：`mac/phase1b-process-identity`
- **核心目标**：在不修改原有 Windows (`win32`) PowerShell + Job Object 逻辑的前提下，为 `desktop/task-system/platform/process-identity.cjs` 补充轻量级 macOS (`darwin`) 与 POSIX 宿主进程身份采集 (`currentIdentity`/`inspect`) 与存活探测 (`probe`)，使任务中心宿主 (`task-system-composition.cjs` / `host.cjs` / `library/index.cjs` / `global-settings.cjs`) 能在 macOS 上正常初始化并管理本地数据库与配置锁。

## 2. 需求细节与范围边界 (Requirements & Scope)
- **核心功能点**：
  1. **轻量级 macOS / POSIX 宿主身份采集 (`action: "host"`)**：
     - 在 `darwin` 下使用单一权威来源：通过 `sysctl -n kern.bootsessionuuid` 获取 `bootId`，通过 `ioreg -rd1 -c IOPlatformExpertDevice` 提取 `IOPlatformUUID` 获取 `hostId`（不混用 `kern.boottime` 或 `kern.uuid` 等异构回退源，防止同一启动会话内因主源偶发失败切换回退源而产生虚假的 `bootId`/`hostId` 不一致）；
     - 在 `linux` 下使用单一权威来源：读取 `/proc/sys/kernel/random/boot_id` 与 `/etc/machine-id`；
     - 若 `hostId` 或 `bootId` 无法获取，诚实返回 `{ status: "unknown", reason: "HOST_IDENTITY_UNAVAILABLE" }`；在 `probe` 收到 `actual.status === "dead"` 后二次核验 `host` 时，若 `host` 读取失败（缺少 `hostId` 或 `bootId`），同样返回 `{ status: "unknown", reason: "HOST_IDENTITY_UNAVAILABLE" }` 而非误报 `HOST_OR_BOOT_MISMATCH`。
  2. **轻量级 macOS / POSIX 进程身份读取 (`inspect` / `currentIdentity`)**：
     - 通过 `ps -ww -p <pid> -o pid=,uid=,lstart=,comm=` 与 `ps -ww -p <pid> -o pid=,uid=,lstart=,args=`（固定 `LC_ALL=C TZ=UTC`）采集目标 PID 的 `userId`、UTC 启动时间 `startedAt`、`creationFileTime`、`executableIdentity` 与 `commandLine`，并校验两次 `ps` 采样的 `pid`、`uid`、`lstart` 完全一致；
     - 当 `ps` 正常退出且退出码为 `1`（无输出、无错误）时返回 `{ status: "dead" }`；当 `ps` 执行失败、超时或输出异常时返回 `{ status: "unknown" }`；
     - 支持通过 `options.execFile` 注入自定义命令执行器以便在任意平台上编写确定性单元测试。
  3. **宿主进程存活探测 (`probe`)**：
     - 复用原有的 `probe(identity)` 流程：在 `darwin`/`linux` 上调用 `control({ action: "inspect", pid: identity.pid })` 与 `control({ action: "host" })`，准确返回 `alive`、`dead`、`conflict`（PID 复用或 `hostId`/`bootId` 变化）或 `unknown`。
- **非目标边界 (Out of Scope)**：
  - **macOS 不支持本机直接运行 ORCA / Gaussian 计算任务 (`local` 环境)**：用户已明确确认 Mac 本机仅使用远程 SSH / Slurm 计算，不运行本机 ORCA / Gaussian 任务；因此本机任务启动与进程树沙盒 (`launch`、`stop`、`waitTreeEnded`、`inspectOwnedWindows`、`inspectNativeWindows`) 保持仅限 `win32`（非 `win32` 下 `launch` 继续抛出 `PLATFORM_NOT_IMPLEMENTED`，`stop` / `waitTreeEnded` 返回 `VERIFIED_JOB_REQUIRED`）。
  - **不在 POSIX `inspect` 中进行命令行分词 (`argv` 猜测)**：POSIX `ps` 不提供未扁平化的 `argv` 数组，因此 POSIX `inspect` 不返回 `argv` 字段；当调用方显式传入 `context.args` 而底层无精确 `actual.argv` 数组时，`inspect` 直接返回 `null`。
  - **关于 `ps lstart` 秒级精度的边界说明**：本模块在 macOS 上仅用于 Electron 任务中心宿主进程（`es-task-host`）的本地数据库与配置锁身份识别，不用于高频短生命周期子进程追踪；`ps lstart` 秒级时间戳结合 `pid`、`uid`、`executableIdentity`、`commandLine`、`hostId`、`bootId` 完全满足宿主锁场景需求。

## 3. 技术设计方案 (Technical Design)
- **涉及文件清单**：
  - `docs/MACOS_PORTING_ROADMAP.md`
  - `desktop/task-system/platform/process-identity.cjs`
  - `tests/desktop/task-system/platform/process-identity.test.mjs`
  - `scripts/workflow/codex-review.mjs`
  - `tests/workflow/codex-review.test.mjs`
- **跨平台兼容性考量 (macOS / Linux / Windows)**：
  - `win32` 分支 100% 保持原版实现不变；
  - `darwin` 与 `linux` 分支采用约 130 行纯 Node.js + `execFile` (`sysctl`/`ioreg`/`ps`) 轻量实现，无任何第三方原生编译依赖、无内嵌 Python 脚本或私有内核符号调用。

## 4. 自动化测试计划 (Automated Test Plan)
- **测试文件路径**：
  - `tests/desktop/task-system/platform/process-identity.test.mjs`
  - `tests/workflow/codex-review.test.mjs`
- **覆盖场景与边界条件**：
  1. `validateArgumentSerialization` 与 `identityMatches` 单元测试；
  2. 注入 `options.execFile` 的 `darwin` / `linux` / `win32` 契约测试：
     - `inspect`、`currentIdentity` 与 `probe` 正常存活 (`alive`)、进程退出 (`dead`)、跨重启或不同机器 (`HOST_OR_BOOT_MISMATCH`)、PID 复用 (`PROCESS_IDENTITY_MISMATCH`) 及命令失败 (`unknown`) 场景；
     - 非 `win32` 平台调用 `launch` 抛出 `PLATFORM_NOT_IMPLEMENTED`、调用 `stop` / `waitTreeEnded` 返回 `VERIFIED_JOB_REQUIRED`；
  3. macOS 真机集成测试：
     - 真实调用 `currentIdentity()`、`inspect(process.pid)`、`probe(identity)`，以及真实子进程退出前后的 `alive` -> `dead` 状态转换与 `createTaskSystemComposition` 宿主初始化验证。

## 5. 用户沟通与意图确认记录 (User Intent Confirmation)
- **原始诉求**：用户指出 Mac 本机无需直接运行 ORCA / Gaussian（仅需远程 SSH / Slurm 计算），并要求回退此前过度设计的数千行进程树沙盒修改，将 `process-identity.cjs` 改造为轻量化版本。
- **澄清问题与结论**：已与用户确认在 macOS 上屏蔽本机 ORCA / Gaussian 计算任务，仅保留远程 SSH / Slurm 计算；`process-identity.cjs` 在 macOS 上仅需提供轻量级的任务中心宿主进程身份与存活探测（`currentIdentity` / `inspect` / `probe`），无需实现本机计算进程树沙盒 (`launch`)。
- **用户确认状态**：已确认
