# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段三微分支 3A —— 外部 Multiwfn CLI 调用兼容与自动发现 (`orbital-runtime.cjs` & `multiwfn_resources.py`)
- **关联分支**：`mac/phase3a-multiwfn-runtime`
- **目标概要**：遵循用户指示，不在软件内部编译或捆绑 Multiwfn，而是直接调用本机安装的 Multiwfn 命令行程序（如 Homebrew 安装的 `/opt/homebrew/opt/multiwfn/bin/multiwfn` 或 `/opt/homebrew/bin/multiwfn`）。为此适配 `desktop/orbital-runtime.cjs` 与 `desktop/chemistry/multiwfn_resources.py`，支持小写 `multiwfn` 文件名、POSIX 符号链接解析、标准安装路径自动发现以及 Homebrew `etc/multiwfn/settings.ini` 配置文件回退。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **外部 Multiwfn 路径解析、符号链接兼容与自动发现 (`desktop/orbital-runtime.cjs`)**：
     - `createOrbitalBackendStore(root, options = {})` 保持原有单参数调用向后兼容，支持可选配置 `{ platform = process.platform, env = process.env, defaultCandidates }`：
     - **Windows (`platform === 'win32'`)**：保持原有严格行为（传入非符号链接目录时拼接 `Multiwfn.exe`，要求目标文件为非符号链接的普通文件且文件名匹配 `/^Multiwfn(?:\.exe)?$/i`）。
     - **POSIX (`platform !== 'win32'`，含 macOS/Linux)**：
       - 支持传入可执行文件或目录（包括 Homebrew 常见的符号链接目录或符号链接二进制，如 `/opt/homebrew/bin/multiwfn`、`/opt/homebrew/opt/multiwfn`、`/opt/homebrew/opt/multiwfn/bin`）；
       - 若解析后为目录，依次探测目录下的 `Multiwfn`、`multiwfn`、`bin/Multiwfn`、`bin/multiwfn`；
       - 通过 `fs.realpath` 解析真实路径，验证目标为普通文件（`stat.isFile()`）、文件名匹配 `/^Multiwfn(?:\.exe)?$/i` 且具备可执行权限（`(stat.mode & 0o111) !== 0`）。
     - **未手动配置时的外部 CLI 自动发现 (`info()`)**：
       - 优先读取 `orbital-backend.json` 中用户通过 `select()` 持久化的路径；
       - 若尚未配置 `orbital-backend.json`（或配置已失效），依次探测环境变量（`env.SCIYUE_MULTIWFN`、`env.Multiwfnpath`）及平台默认外部路径（`darwin` 下默认探测 `['/opt/homebrew/opt/multiwfn/bin/multiwfn', '/opt/homebrew/bin/multiwfn', '/usr/local/opt/multiwfn/bin/multiwfn', '/usr/local/bin/multiwfn']`），首个通过 `checked()` 校验的候选直接返回 `{ configured: true, path: resolvedPath }`。
  2. **Homebrew `settings.ini` 路径回退 (`desktop/chemistry/multiwfn_resources.py`)**：
     - `resolve_resources` 查找 `settings.ini` 时，若 `Path(executable).resolve().parent / 'settings.ini'` 不存在且 `Path(executable).resolve().parent.parent / 'etc' / 'multiwfn' / 'settings.ini'` 存在，则回退读取后者（兼容 `digital-chemistry-laboratory/multiwfn` CMake 安装布局），若均不存在则保持原有默认行为。
- **边界与非目标 (Out of Scope)**：
  - 不在仓库或应用包内内置/编译 Multiwfn 二进制。
  - 不修改 `desktop/orbital-host.cjs`、`desktop/surface-analysis.cjs`、`desktop/interaction-analysis.cjs`、`desktop/electronic-analysis.cjs` 等上层分析宿主。
  - macOS `.app` 与 `.dmg` 打包脚本将在紧随其后的微分支 3B (`mac/phase3b-macos-packaging`) 中完成。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `desktop/orbital-runtime.cjs`
  - `desktop/chemistry/multiwfn_resources.py`
  - `tests/desktop/orbital-runtime.test.mjs`
- **跨平台适配考量（macOS / Windows / Linux）**：
  - `win32`：完全保留原有 `lstat` 非符号链接校验与 `Multiwfn.exe` 目录拼接逻辑。
  - `darwin` / `linux`：兼容 Homebrew / 系统包管理器的符号链接与小写 `multiwfn` 命名，并校验 `0o111` 执行权限。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/orbital-runtime.test.mjs`
- **核心验证场景与边界条件**：
  1. 验证 POSIX 下直接选择 `multiwfn`、包含 `multiwfn` 或 `bin/multiwfn` 的目录、以及指向 `multiwfn` 的符号链接（模拟 `/opt/homebrew/bin/multiwfn`）均可正确解析为真实可执行文件路径。
  2. 验证未配置 `orbital-backend.json` 时可通过 `defaultCandidates` / `SCIYUE_MULTIWFN` 自动发现外部 Multiwfn，且手动调用 `select()` 后优先返回用户选择的路径。
  3. 验证异常拦截：空/不存在路径、非 `Multiwfn` 文件名、POSIX 下缺少可执行权限 (`0o644`)、以及 `win32` 下拒绝符号链接。
  4. 验证 `multiwfn_resources.py` 对 `<prefix>/etc/multiwfn/settings.ini` 的回退读取，以及本机已安装的 `/opt/homebrew/opt/multiwfn/bin/multiwfn` 端到端轨道计算调用。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - “我建议不要这么麻烦，它不是已经有编译好的吗？直接在电脑上安装一个编译好的，看看我们能不能调用吧。我看它原来好像也是通过命令行之类的方式调用 Multiwfn，不用搞编译到内部去的这种操作了，有点麻烦。而且 Multiwfn 可能会更新，这样我们可以跟踪它的最新版本，而我们软件不用改”
- **澄清细节与确认结论**：
  - 已在本机安装好编译版 Multiwfn (`/opt/homebrew/opt/multiwfn/bin/multiwfn` 及 `/opt/homebrew/bin/multiwfn`) 并实测 Python `MultiwfnSession` CLI 交互可成功生成轨道格点；本分支仅做轻量级外部 CLI 路径发现与符号链接/大小写兼容，不将 Multiwfn 编译进软件内部。
- **是否已获得用户开发确认**：已确认
