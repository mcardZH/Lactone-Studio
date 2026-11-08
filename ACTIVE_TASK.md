# ACTIVE_TASK.md — 当前开发任务规格说明书

> **生命周期说明**：本文件仅记录当前活跃开发分支的任务需求、技术方案与用户意图确认结果。在当前分支通过测试与 `gpt-6.1-terra` 独立复核并合并到 `main` 后，自动化脚本会将本文件重置为空模板。

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段二（步骤 1/3）：macOS 本地 xTB 半经验计算运行时解锁 (`xtb-runtime`)
- **关联分支**：`mac/phase2a-xtb-runtime`
- **核心目标**：扩展 `desktop/xtb-runtime-contract.cjs` 与 `desktop/xtb-runtime.cjs`，在完整保留 `win32-x64`（`bin/xtb.exe` 及 Windows DLL 校验）行为不变的前提下，支持 `darwin-arm64` 与 `darwin-x64` 平台的 `xtb` 运行时描述符校验、动态库 (`lib/*.dylib`) 清单校验与 `bin/xtb` 可执行文件解析。

## 2. 需求细节与范围边界 (Requirements & Scope)
- **核心功能点**：
  1. **跨平台 xTB 运行时契约扩展 (`desktop/xtb-runtime-contract.cjs`)**：
     - 新增 `entryForPlatform(platform)`、`requiredMembersForPlatform(platform)`、`contentRootsForPlatform(platform)`，以及平台专属 v1 动态库常量 `WIN32_V1_LIBRARIES`（`bin/libiomp5md.dll`、`bin/vcruntime140.dll`）与 `DARWIN_V1_LIBRARIES`（`lib/libblas.3.dylib`、`lib/libgcc_s.1.1.dylib`、`lib/libgfortran.5.dylib`、`lib/liblapack.3.dylib`、`lib/libomp.dylib`、`lib/libopenblas.0.dylib`、`lib/libquadmath.0.dylib`），同时保留原有 `REQUIRED` 导出以兼容旧调用方；
     - 扩展 `validateDescriptor(record)`，允许 `record.platform` 为 `'win32-x64'`（对应 `record.entry === 'bin/xtb.exe'`）、`'darwin-arm64'` 或 `'darwin-x64'`（对应 `record.entry === 'bin/xtb'`），且 `record.dataDirectory === 'share/xtb'`。
  2. **跨平台 xTB 运行时加载器 (`desktop/xtb-runtime.cjs`)**：
     - 支持传入可选 `{ platform, arch, platformId }`（默认取当前进程 `${process.platform}-${process.arch}`），在开发模式下透传给 `developmentXtb(appPath, { platform, arch, platformId })`，并强制核验 `record.platform === expectedPlatform`（防止跨平台混用运行时目录）；
     - 根据已校验的 `record.entry` 解析 `executable` 绝对路径（Windows 为 `bin/xtb.exe`，macOS 为 `bin/xtb`），并在非 Windows 平台上校验 `bin/xtb` 具备可执行权限（`(stat.mode & 0o111) !== 0`）；
     - 根据 `record.platform` 选择对应的内容根目录（`win32-x64` 为 `['bin', 'share/xtb']`，`darwin-*` 为 `['bin', 'lib', 'share/xtb']`）、v1 必需动态库与必需文件清单。
- **非目标边界 (Out of Scope)**：
  - 本分支仅修改 `desktop/xtb-runtime-contract.cjs`、`desktop/xtb-runtime.cjs` 并新增配套单元测试 `tests/desktop/xtb-runtime.test.mjs`。
  - 不修改 `desktop/xtb-host.cjs`、`desktop/aiss-host.cjs` 或 `desktop/chemistry/conformer_native_md.py`（`xtb-host.cjs` 与 `aiss-host.cjs` 已原生支持 `/^(?:xtb|xtb\.exe)$/i`）。
  - 任务中心 SSH 环境路径适配与 MolVec OCR 跨平台化将在后续微分支 2B、2C 中独立推进。

## 3. 技术设计方案 (Technical Design)
- **涉及文件清单**：
  - `desktop/xtb-runtime-contract.cjs`
  - `desktop/xtb-runtime.cjs`
  - `tests/desktop/xtb-runtime.test.mjs`
- **跨平台兼容性考量 (macOS / Linux / Windows)**：
  - `win32-x64` 分支 100% 保持原有 `bin/xtb.exe`、`['bin', 'share/xtb']` 及 `bin/libiomp5md.dll`、`bin/vcruntime140.dll` 校验行为；
  - `darwin-arm64` 与 `darwin-x64` 严格匹配阶段一 `scripts/native/stage-darwin-runtime.mjs` 与 `desktop/packaging/xtb-runtime.darwin-arm64.lock.json` 生成的目录结构（`bin/xtb`、`lib/*.dylib`、`share/xtb/*`、`runtime.json`）。

## 4. 自动化测试计划 (Automated Test Plan)
- **测试文件路径**：
  - `tests/desktop/xtb-runtime.test.mjs`
- **覆盖场景与边界条件**：
  1. `validateDescriptor`、`entryForPlatform`、`requiredMembersForPlatform` 与 `contentRootsForPlatform` 在 `win32-x64`、`darwin-arm64`、`darwin-x64` 及非法平台/入口组合下的单元测试；
  2. 构造沙箱目录测试 `xtbRuntime` 在 `win32-x64`、`darwin-arm64`、`darwin-x64`（含 v1 与打包态 v2 清单）下的完整解析、跨平台描述符不匹配拒绝、缺少动态库或参数文件拒绝、符号链接拒绝以及非可执行 `bin/xtb` 拒绝；
  3. macOS (`darwin-arm64`) 真机测试：调用 `xtbRuntime({ packaged: false, appPath: ROOT })` 解析仓库已组装的 `.local/dependencies/darwin-arm64/conda-chem-arm64/xtb` 运行时并核验返回的 `executable`、`dataDirectory`、`version` 与 `engineIdentity`。

## 5. 用户沟通与意图确认记录 (User Intent Confirmation)
- **原始诉求**：按阶段二的 3 个微分支计划逐步推进，首先完成微分支 2A（`mac/phase2a-xtb-runtime`）解锁 macOS 本地 xTB 运行时。
- **澄清问题与结论**：已与用户确认按 2A -> 2B -> 2C 三个微分支依次推进，若遇连续 3 次复核未通过立即反馈人工排查。
- **用户确认状态**：已确认
