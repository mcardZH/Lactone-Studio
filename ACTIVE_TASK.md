# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段三微分支 3B —— macOS 原生应用包 (`Ester Studio.app`) 与磁盘镜像 (`.dmg`) 打包支持
- **关联分支**：`mac/phase3b-macos-packaging`
- **目标概要**：适配 `desktop/main.cjs` 在 macOS 打包态（`app.isPackaged === true`）下的用户数据目录策略（使用 `appData` 标准目录而非在 `.app` 包内部写入便携状态文件），并提供轻量化 macOS 打包脚本 `scripts/release/package-macos.mjs`（及 `npm run package:mac` 命令），支持将前端构建产物、Electron 主进程、Python 科学计算引擎 (`Resources/chemistry/engine`) 与内置 xTB (`Resources/xtb`) 组装为原生 `Ester Studio.app` 及 `.dmg` 安装镜像。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **macOS 打包态用户数据目录隔离 (`desktop/main.cjs`)**：
     - 将 `desktop/main.cjs` 第 89 行的 `} else if (app.isPackaged) {` 限定为 `} else if (app.isPackaged && process.platform === 'win32') {`。
     - 在 Windows 打包态下完全保留原有 `resolvePortableLayout` + `createPortableProfile` 便携目录逻辑；在 macOS (`darwin`) 打包态下走标准 `prepareVersionProfile(fsSync, app.getPath('appData'), ...)`，避免向只读 `.dmg` 或 `.app/Contents/MacOS` 写入状态目录。
  2. **macOS `.app` 与 `.dmg` 组装脚本 (`scripts/release/package-macos.mjs` & `package.json`)**：
     - 导出可测试的 `assembleMacAppBundle(options)` 与 CLI 入口，并在 `package.json` 中注册 `"package:mac": "node scripts/release/package-macos.mjs"`：
     - 基于 `node_modules/electron/dist/Electron.app` 模板复制生成 `Ester Studio.app`：
       - 更新 `Contents/Info.plist` 中的 `CFBundleName`、`CFBundleDisplayName` (`Ester Studio`)、`CFBundleIdentifier` (`com.sciyue.esterstudio`)、`CFBundleShortVersionString` 与 `CFBundleVersion`；
       - 将应用代码与前端静态构建产物写入 `Contents/Resources/app/`（含 `package.json`、`LICENSE.txt`、`desktop/`、`dist/` 及运行所需的 `node_modules` 生产依赖，可选包含 `runtime/ocr`）；
       - 在 `Contents/Resources/chemistry/` 中组装 `desktop/chemistry/*.py`、Python 运行时与可执行启动器 `Contents/Resources/chemistry/engine`（设置隔离的 `PYTHONNOUSERSITE=1`、`PYTHONPATH`、`DYLD_FALLBACK_LIBRARY_PATH`、`RDKIT_DATA_DIR` 后调用打包的 `python3 -s -B engine.py "$@"`），与 `desktop/runtime.cjs` 的 `packaged: true` 契约无缝对接；
       - 将 `.local/dependencies/darwin-<arch>/conda-chem-<arch>/xtb` 复制到 `Contents/Resources/xtb/`，与 `desktop/xtb-runtime.cjs` 的 `packaged: true` 契约无缝对接；
       - 支持通过 `codesign --force --deep --sign -` 执行 ad-hoc 签名，以及通过 `hdiutil create` 生成 `.dmg` 安装镜像（可通过参数控制跳过耗时的完整构建以便快速单元测试）。
- **边界与非目标 (Out of Scope)**：
  - 不在 `.app` 内部打包 Multiwfn（Multiwfn 已在微分支 3A 中作为本机外部 CLI 程序由 `orbital-runtime.cjs` 自动发现与调用）。
  - 不引入第三方重量级打包框架（如 `electron-builder`），直接使用仓库现有 Electron 模板与 macOS 系统工具（`plutil`/`codesign`/`hdiutil`）完成组装。
  - 不涉及 Apple Developer ID 付费公证（Notarization），采用本机可运行的 ad-hoc 签名（`-`）。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `desktop/main.cjs`
  - `scripts/release/package-macos.mjs`
  - `package.json`
  - `tests/desktop/package-macos.test.mjs`
- **跨平台适配考量（macOS / Windows / Linux）**：
  - `win32`：`desktop/main.cjs` 保留原有 Windows 便携包布局逻辑不变。
  - `darwin`：生成的 `Contents/Resources/chemistry/engine` 与 `Contents/Resources/xtb` 严格匹配 `chemistryRuntime({ packaged: true })` 和 `xtbRuntime({ packaged: true })`。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/package-macos.test.mjs`
- **核心验证场景与边界条件**：
  1. 使用轻量级沙箱 fixture 验证 `assembleMacAppBundle` 能正确生成 `Ester Studio.app` 目录结构、`Contents/Resources/app`、`Contents/Resources/chemistry/engine`（含 `0o755` 执行权限）及 `Contents/Resources/xtb`。
  2. 验证生成的 `Contents/Resources/chemistry/engine` 与 `Contents/Resources/xtb` 能通过 `chemistryRuntime({ packaged: true })` 与 `xtbRuntime({ packaged: true })` 解析校验。
  3. 验证 `desktop/main.cjs` 在非 `win32` 平台打包态下不触发 Windows 专属的 `resolvePortableLayout`。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - “这里有一个别人编译好的multiwfn的macos版，可以纳入。然后就可以打包编译了”
  - “直接在电脑上安装一个编译好的，看看我们能不能调用吧……不用搞编译到内部去的这种操作了”
- **澄清细节与确认结论**：
  - 微分支 3A 已完成外部 Multiwfn CLI 调用与合入 `main`；本微分支 3B 完成 macOS `.app` 与 `.dmg` 打包支持并实机编译生成安装包。
- **是否已获得用户开发确认**：已确认
