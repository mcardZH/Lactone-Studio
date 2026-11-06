# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段 1A-1b：科学引擎启动器与 Python 隔离引导器（`mac/phase1a2-python-dev-bootstrap`）
- **关联分支**：`mac/phase1a2-python-dev-bootstrap`
- **目标概要**：更新 `desktop/runtime.cjs` 支持跨平台（`win32-x64`、`darwin-arm64`、`darwin-x64`）打包与开发态科学引擎启动参数解析，并实现 `scripts/native/dev-runtime.py` 开发态 Python 隔离引导器，确保仅从项目锁定的 `.local/dependencies` 与 `.local/toolchains` 加载标准库与科学依赖，禁止回退至系统/用户/Conda 环境。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **科学引擎启动器跨平台解析 (`desktop/runtime.cjs`)**：
     - `packaged` 模式下按 `platform` 解析 `chemistry/engine.exe`（Windows）或 `chemistry/engine`（macOS/POSIX）。
     - 开发模式下校验 `desktop/chemistry/engine.py` 存在性，支持显式 `SCIYUE_PYTHON` 绝对路径覆盖（`['-B', engine]`），默认调用 `developmentNative(appPath, { platform, arch, platformId })` 并返回隔离启动参数 `['-I', '-S', '-B', path.join(appPath, 'scripts/native/dev-runtime.py')]`。
  2. **Python 隔离运行时引导器 (`scripts/native/dev-runtime.py`)**：
     - 清理继承自宿主进程的 `_PYTHON_*` 与 `RDBASE`（不区分大小写）环境变量，开启 `sys.dont_write_bytecode = True`。
     - 实现 `detect_host_platform()`：支持 `win32-x64`、`darwin-arm64`、`darwin-x64`；在 Darwin 上若 `os.uname()` 抛出 `PermissionError` 或返回空架构，局部回退至直接解析当前可执行文件的 Mach-O 头部（支持单架构与 Universal 2 胖二进制进程内存头部探测），不全局覆写 `os.uname`。
     - 实现 `_admitted_path` 与 `load_active_profile`：拒绝符号链接、Junction 及硬链接数大于 1 的输入文件；当平台专属 `native-profile.<platform>.json` 存在（含悬空符号链接）时不静默回退至默认 `native-profile.json`。
     - 实现 `configure_isolated_paths(app_path)`：
       - 校验 `runtime` 与 `toolchain` 锁文件 schema、平台、固定父目录（`.local/dependencies/...` 与 `.local/toolchains/...`）、显式非空 `contentDirectories` 以及当前 Python 解释器（`sys.executable`、`sys.prefix`、`sys.base_prefix`）严格位于锁定工具链目录内。
       - 过滤 `sys.path`：仅保留锁定工具链 `contentDirectories` 内已验证的标准库目录与 `.zip` 标准库归档（如 Windows 嵌入式 Python 的 `python312.zip`），剔除工具链自带的 `site-packages`/`dist-packages`，并将锁定依赖根下的 `site-packages` 与 `desktop/chemistry` 置于 `sys.path` 首位。
       - Windows 下通过 `os.add_dll_directory` 注册已验证的 `python/Library/bin`、`python`、`python/DLLs` 目录并将句柄保存在 `sys._sciyue_dll_handles` 中。
- **边界与非目标 (Out of Scope)**：
  - 本分支**不涉及** `.local` 科学计算环境实际构建脚本与锁文件生成（将在下一分支 `mac/phase1a3-darwin-staging` 实现）。
  - 本分支**不涉及** xTB 宿主执行器（`desktop/xtb-runtime.cjs`）或任务系统进程树管理（将在 `mac/phase1b-process-identity` 实现）。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `desktop/runtime.cjs`
  - `scripts/native/dev-runtime.py`
  - `tests/desktop/runtime.test.mjs`
  - `tests/native/dev-runtime.test.mjs`
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 兼容 macOS (`darwin-arm64`, `darwin-x64`) 与 Windows (`win32-x64`) 的目录结构差异及 Windows 嵌入式 Python `.zip` 标准库归档。
- **关键实现逻辑与架构影响**：
  - `desktop/runtime.cjs` 与 `desktop/current-runtime.cjs`、`scripts/native/dev-runtime.py` 共享一致的锁路径与目录准入规则。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/runtime.test.mjs`
  - `tests/native/dev-runtime.test.mjs`
- **核心验证场景与边界条件**：
  - `chemistryRuntime` 在 `packaged`（Windows `engine.exe` vs Darwin `engine`）、`SCIYUE_PYTHON` 覆盖、锁定开发态及缺失文件异常下的行为测试；
  - `dev-runtime.py` 对 `_PYTHON_HOST_PLATFORM` 伪造清理、`os.uname()` `PermissionError` 局部 Mach-O 头部回退（含 Universal 2）、非 `.local` 锁根拒绝、符号链接父目录拦截、悬空平台专属 profile 拦截、Windows `python312.zip` 标准库保留与 `os.add_dll_directory` 句柄注册测试。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 将阶段 1 拆分为独立微分支推进，在合并 `mac/phase1a1-node-runtime-contract` 后继续推进 `mac/phase1a2-python-dev-bootstrap`。
- **澄清细节与确认结论**：
  - 用户已明确确认微分支拆分方案及合并第一分支后继续推进本分支，并在复核提示词中严格聚焦本分支修改范围。
- **是否已获得用户开发确认**：是
