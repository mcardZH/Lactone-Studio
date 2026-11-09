# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段三微分支 3B —— macOS 原生应用包 (`Ester Studio.app`) 与磁盘镜像 (`.dmg`) 打包支持
- **关联分支**：`mac/phase3b-macos-packaging`
- **目标概要**：适配 `desktop/main.cjs` 与 `desktop/preload.cjs` 在 macOS 打包态（`app.isPackaged === true`）下的标准用户数据目录策略（使用 `prepareVersionProfile` 标准 `appData` 目录，不启用 Windows 专属的便携版 `portableProfile` / `portableTools` 模式），并提供轻量化 macOS 打包脚本 `scripts/release/package-macos.mjs`（及 `npm run package:mac` 命令），支持将前端构建产物、Electron 主进程、Python 科学计算引擎 (`Resources/chemistry/engine`) 与内置 xTB (`Resources/xtb`) 组装为原生 `Ester Studio.app` 及 `.dmg` 安装镜像。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **macOS 打包态采用标准 `appData` 版本目录隔离 (`desktop/main.cjs` & `desktop/preload.cjs`)**：
     - 在 `desktop/main.cjs` 的 `app.isPackaged` 分支中，仅在 `process.platform === 'win32'` 时调用 Windows 专属的 `resolvePortableLayout` 与 `createPortableProfile`；在非 Windows（如 macOS `darwin`）下即使 `app.isPackaged === true` 也统一走 `prepareVersionProfile(fsSync, app.getPath('appData'), ...)` 标准版本配置目录（`~/Library/Application Support/SciYue/profiles/v2.0.2`），避免在只读 `.app` 包或 `.dmg` 卷内创建便携目录，也不启用 Windows 专属的 `portableProfile`；
     - 在 `desktop/preload.cjs` 中仅在 `process.platform === 'win32' || process.env?.SCIYUE_TEST_ISOLATED_IO === '1'` 时暴露 `portableTools`，使前端 `WorkspaceShell.tsx`（`Boolean(desktop?.portableTools)`）在 macOS 下自动隐藏 Windows 专属的“运行数据”便携面板入口；同时在 `desktop/main.cjs` 的 `portable-tools` 处理器中对未启用 `portableServices` 的情况返回结构化错误而非抛异常。
  2. **macOS `.app` 与 `.dmg` 组装脚本 (`scripts/release/package-macos.mjs` & `package.json`)**：
     - 导出可测试的 `assembleMacAppBundle(options)`、`resolveDefaultMacRuntimeSources(repoRoot, arch)`、`parseCliArgs(argv)` 与 CLI 入口，并在 `package.json` 中注册 `"package:mac": "node scripts/release/package-macos.mjs"`：
     - 支持从目标平台（`darwin-arm64` / `darwin-x64`）的 `desktop/packaging/native-profile.darwin-<arch>.json` 及对应锁文件（`native-toolchain` / `native-runtime` / `xtb-runtime`）自动解析 Python 工具链、科学计算依赖与 xTB 源目录，并兼容 `stageDarwinRuntime` 默认目录名（`conda-py312-arm64` / `conda-chem-arm64` 及 `conda-py312-<arch>` / `conda-chem-<arch>`）以及 CLI 参数覆盖；
     - 基于 `node_modules/electron/dist/Electron.app` 模板复制生成 `Ester Studio.app`：
       - 重命名主可执行文件 `Contents/MacOS/Ester Studio` 及全部 4 个 `Ester Studio Helper*.app`，移除 `default_app.asar`，并更新 `Info.plist` 中的 `CFBundleExecutable`、`CFBundleName`、`CFBundleDisplayName`、`CFBundleIdentifier`、`CFBundleShortVersionString` 与 `CFBundleVersion`；
       - 将应用代码与前端静态构建产物写入 `Contents/Resources/app/`（含 `package.json`、`LICENSE.txt`、`desktop/`、`dist/` 及运行所需的 `node_modules` 生产依赖，可选包含 `runtime/ocr`）；
       - 在 `Contents/Resources/chemistry/` 中组装 `desktop/chemistry/*.py`、Python 运行时、`bootstrap.py` 与可执行启动器 `Contents/Resources/chemistry/engine`（使用 `python3 -I -S -B "$DIR/bootstrap.py" "$@"` 在 C 层彻底隔离 `PYTHONPLATLIBDIR`/`PYTHONVERBOSE` 等外部环境变量并显式挂载内置 `deps/lib/python3.12/site-packages`），与 `desktop/runtime.cjs` 的 `packaged: true` 契约无缝对接；
       - 将 xTB 运行时复制到 `Contents/Resources/xtb/`，与 `desktop/xtb-runtime.cjs` 的 `packaged: true` 契约无缝对接；
       - 支持通过 `codesign --force --deep --sign -` 执行 ad-hoc 签名，以及通过 `hdiutil create` 生成包含 `Ester Studio.app` 与 `Applications` 软链接的 `.dmg` 安装镜像。
- **边界与非目标 (Out of Scope)**：
  - **不在 macOS 上启用 Windows 便携目录模式 (`portableProfile` / `portableServices`)**：经与用户明确确认（方案 A），macOS 采用系统标准 `Application Support` 版本目录（`prepareVersionProfile`），不启用 Windows 专属的便携版目录模式与导出路径防覆盖检查。
  - 不在 `.app` 内部打包 Multiwfn（Multiwfn 已在微分支 3A 中作为本机外部 CLI 程序由 `orbital-runtime.cjs` 自动发现与调用）。
  - 不引入第三方重量级打包框架（如 `electron-builder`），直接使用仓库现有 Electron 模板与 macOS 系统工具（`plutil`/`codesign`/`hdiutil`）完成组装。
  - 不涉及 Apple Developer ID 付费公证（Notarization），采用本机可运行的 ad-hoc 签名（`-`）。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `desktop/main.cjs`
  - `desktop/preload.cjs`
  - `scripts/release/package-macos.mjs`
  - `package.json`
  - `tests/desktop/package-macos.test.mjs`
- **跨平台适配考量（macOS / Windows / Linux）**：
  - `win32`：`desktop/main.cjs` 与 `desktop/preload.cjs` 保留原有 Windows 便携包布局与 `portableTools` 逻辑不变。
  - `darwin`：打包态使用 `prepareVersionProfile` 标准 `Application Support` 目录，生成的 `Contents/Resources/chemistry/engine` 与 `Contents/Resources/xtb` 严格匹配 `chemistryRuntime({ packaged: true })` 和 `xtbRuntime({ packaged: true })`。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/package-macos.test.mjs`
- **核心验证场景与边界条件**：
  1. 使用轻量级沙箱 fixture 验证 `assembleMacAppBundle` 能正确生成 `Ester Studio.app` 目录结构、重命名主程序与 Helper、`Contents/Resources/app`、`Contents/Resources/chemistry/engine`（含 `-I` 隔离启动与 `0o755` 执行权限）及 `Contents/Resources/xtb`。
  2. 验证 `darwin-x64` 在使用 `stageDarwinRuntime` 默认目录布局（`conda-py312-arm64` / `conda-chem-arm64`）或锁文件配置时均可正确解析并完成打包。
  3. 验证 `desktop/main.cjs` 与 `desktop/preload.cjs` 在 macOS 打包态下采用标准 `prepareVersionProfile` 目录且不暴露 Windows 专属 `portableTools`。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - “这里有一个别人编译好的multiwfn的macos版，可以纳入。然后就可以打包编译了”
  - “直接在电脑上安装一个编译好的，看看我们能不能调用吧……不用搞编译到内部去的这种操作了”
  - “可以，按方案A修改，然后复用的你正常复用”（明确确认 macOS 采用系统标准 `Application Support` 版本目录 `prepareVersionProfile`，不启用 Windows 专属便携版 `portableProfile` 模式，并复用锁文件解析运行时目录）
- **澄清细节与确认结论**：
  - 微分支 3A 已完成外部 Multiwfn CLI 调用与合入 `main`；本微分支 3B 按用户确认的方案 A 完成 macOS `.app` 与 `.dmg` 打包支持并实机编译生成安装包。
- **是否已获得用户开发确认**：已确认
