# Ester Studio macOS 平台适配与打包路线图 (`MACOS_PORTING_ROADMAP.md`)

本文档记录 **Ester Studio v2.0.2** 向 macOS（`darwin-arm64` Apple Silicon 与 `darwin-x64` Intel）移植的平台兼容性评估结论、系统边界划分及分阶段实施路线。

---

## 1. 平台兼容性矩阵总览

| 功能模块 | macOS 兼容性 | 适配方式与说明 |
| :--- | :---: | :--- |
| **前端工作台 UI、2D/3D 建模、输入卡生成、谱图与轨迹可视化** (`src/**`) | 渲染层原生支持（环境设置页需放开路径校验） | 纯 Web / Electron 渲染层开箱即用；但 `src/web/task-system/EnvironmentSettings.tsx`（`validPath`）与 `environment-assistant.ts` 对本地软件/工作目录及 SSH 私钥路径当前仅接受 Windows 盘符/UNC 格式，需放开支持 macOS POSIX 绝对路径（`/Users/...`）。 |
| **Python 科学计算引擎** (`desktop/chemistry/*.py`) | 有条件支持（待解除平台锁与验证） | 依赖包 (`numpy`, `scipy`, `rdkit`, `ase`, `spglib`, `tblite`, `threadpoolctl`) 均有 macOS 构建版本，但当前 `desktop/runtime.cjs` 与 `current-runtime.cjs` 默认锁定 `win32-x64` 与 `python.exe`，开发态需显式设置 `SCIYUE_PYTHON` 绕过，且需在 macOS 下完成各科学计算子任务的端到端验证。 |
| **本地 xTB 半经验计算与 aISS 对接** (`desktop/xtb-*.cjs`, `aiss-host.cjs`) | 替换二进制 + 解锁后支持 | 使用 macOS 版 `xtb` 二进制，并在 `xtb-runtime.cjs` / `xtb-runtime-contract.cjs` 中支持 `darwin-arm64`/`darwin-x64`。 |
| **MolVec 离线化学结构 OCR** (`desktop/ocr/**`) | 替换 JRE + 解锁后支持 | 核心 `molvec-0.9.8-jar-with-dependencies.jar` 跨平台；将内置 Windows JRE 替换为 macOS JRE (`bin/java`) 并放开 `molvec.cjs` 平台校验即可。 |
| **Multiwfn 波函数与表面分析** (`desktop/orbital-runtime.cjs`) | 外部配置可执行文件支持 | `orbital-runtime.cjs` 已支持非 Windows 名 `Multiwfn`；配置 macOS 版 Multiwfn 即可。 |
| **远程 Linux SSH / Slurm 超算任务提交与监控** (`desktop/task-system/transports/ssh.cjs`) | 微调前后端路径校验后支持 | 实现 `process-identity.cjs` 的轻量级 `darwin` 宿主进程身份探针（`currentIdentity` / `inspect` / `probe`），更新前端 `src/web/task-system/EnvironmentSettings.tsx` (`validPath`) 允许 macOS `/...` 私钥路径，并将后端 `desktop/task-system/environments.cjs` 中的 `path.win32.isAbsolute(privateKeyPath)` 统一改为宿主平台语义的 `path.isAbsolute`。 |
| **本机直接运行 ORCA / Gaussian 任务 (`local` 环境)** (`desktop/task-system/execution/runner.cjs`) | **仅限 Windows（macOS 屏蔽）** | Mac 本机不承担高负载 ORCA / Gaussian 量化计算，统一通过远程 SSH / Slurm 提交执行；在 macOS 上隐藏并禁用 `local` 环境选项，无需改造 `runner.cjs` 本地计算执行器。 |
| **WSL 任务传输层** (`desktop/task-system/transports/wsl.cjs`) | **仅限 Windows（macOS 屏蔽）** | 依赖 `wsl.exe`；在 macOS 上隐藏并禁用该环境选项。 |
| **Gaussian for Windows (`g16w.exe`) 弹窗监控器** (`gaussian-windows.cjs`) | **仅限 Windows** | 专门针对 Windows GUI 版 `g16w.exe` 模态框设计；macOS 版 Gaussian/ORCA 走标准命令行流。 |
| **Windows 注册表文件关联与 C 启动器** (`windows-association-registry.cjs`, `sciyue-launcher.c`) | **仅限 Windows** | macOS 通过 `.app` Bundle 内的 `Info.plist` (`CFBundleDocumentTypes`) 原生声明 `.es`/`.sy` 文件关联。 |
| **远程 SSH 目标机内核环境** (`posix.cjs`, `posix-runner.cjs`) | **目标机需为 Linux** | 远程执行脚本依赖 Linux `/proc` 文件系统与 GNU coreutils（连接远程 Linux 超算/服务器时完全正常）。 |

---

## 2. 分阶段改造路线图

### 阶段一：打通 macOS 本地开发与核心科学引擎（Phase 1 — Core Runtime on macOS）
1. **实现轻量级 `darwin` 宿主进程身份探针 (`desktop/task-system/platform/process-identity.cjs`)**：
   - 当前非 `win32` 平台直接返回 `PLATFORM_NOT_IMPLEMENTED`，导致任务中心宿主初始化报错 `TASK_HOST_IDENTITY_UNAVAILABLE`。
   - 新增轻量级 `darwin`（及 POSIX）宿主身份实现：使用 `sysctl` / `ioreg` 获取系统 `bootId` 与 `hostId`，使用 `ps` 获取进程启动时间、UID、可执行文件路径与命令行以支持 `currentIdentity`、`inspect` 与 `probe`（用于任务中心本地 SQLite 数据库与设置文件锁管理）。因 macOS 仅使用远程 SSH/Slurm 计算而不运行本机 ORCA/Gaussian 任务，本机任务启动与进程树沙盒（`launch` / `stop` / `waitTreeEnded`）保持仅限 Windows (`win32`)。
2. **放开原生运行时平台锁并完成科学引擎验证 (`desktop/current-runtime.cjs`, `desktop/native-capabilities.cjs`)**：
   - 当前默认运行时锁定 `win32-x64` 及 `python.exe`；需在开发模式与 macOS 构建模式下允许 `darwin-arm64` 与 `darwin-x64` 平台标识，并支持通过 `SCIYUE_PYTHON` 或打包后的 macOS `engine` 启动 `desktop/chemistry/engine.py`。
   - **macOS 科学功能验证步骤**：在 macOS Python 环境中针对 `engine.py` 逐项运行自动化测试（几何清理 `geometry_clean.py`、晶体对称性与切面 `crystal_modeling.py`、构象采样 `conformer_sampling.py`、分子动力学 `dynamics.py`、过渡态搜索 `advanced_path.py`、周期性紧束缚 `xtb_periodic.py` 及 Bader 分析 `bader_analysis.py`），验证数值输出与跨平台一致性。

### 阶段二：适配本地 xTB、MolVec OCR 与远程 SSH 任务环境（Phase 2 — xTB, OCR & Remote SSH Task Environment）
1. **xTB 运行时跨平台化 (`desktop/xtb-runtime.cjs`, `desktop/xtb-runtime-contract.cjs`)**：
   - 按 `process.platform === 'win32' ? 'xtb.exe' : 'xtb'` 解析可执行文件名。
   - 支持在 macOS 下加载本地打包或环境提供的 `xtb` 可执行文件及 `share/xtb` 参数库。
2. **MolVec OCR 跨平台化 (`desktop/ocr/molvec.cjs`, `desktop/ocr-runtime.cjs`)**：
   - 支持 `darwin` 平台的 JRE 路径 (`bin/java` 或 `Contents/Home/bin/java`)。
3. **远程 SSH / Slurm 环境适配与屏蔽本地/WSL 环境 (`src/web/task-system/EnvironmentSettings.tsx`, `src/web/task-system/environment-assistant.ts`, `desktop/task-system/environments.cjs`)**：
   - 在 macOS 上屏蔽 `local`（本机 ORCA/Gaussian）和 `wsl`（WSL2）环境选项，仅保留 `ssh`（SSH 服务器）和 `slurm`（SSH + Slurm）。
   - 更新前端 `src/web/task-system/EnvironmentSettings.tsx` 的 `validPath` 与后端 `desktop/task-system/environments.cjs`，允许 `privateKeyPath` 使用 macOS POSIX 绝对路径（`/...`）。

### 阶段三：macOS `.app` 与 `.dmg` 独立打包（Phase 3 — macOS Packaging & Distribution）
1. **Python 科学引擎冻结**：使用 PyInstaller 配合 `desktop/packaging/native-engine.spec`（或打包脚本）在 macOS 上打包生成独立 `engine` 目录。
2. **应用打包与文件关联**：集成 `electron-builder`（或 macOS 专用组装脚本），生成 `Ester Studio.app` 与 `.dmg` 镜像，并在 `Info.plist` 中配置 `.es` / `.sy` 文档类型关联与图标。
