# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段 1A-1a：Node 原生运行时契约、多平台锁校验与环境变量净化（`mac/phase1a1-node-runtime-contract`）
- **关联分支**：`mac/phase1a1-node-runtime-contract`
- **目标概要**：将 `desktop/current-runtime.cjs` 从单一 `win32-x64` 硬编码扩展为支持 `win32-x64`、`darwin-arm64` 与 `darwin-x64` 的多平台运行时契约，强化库存热缓存校验、`import-probe.json` 锁身份绑定、`contentDirectories` 搜索路径全覆盖及路径分隔符安全防御。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **多平台布局与 Profile 解析 (`desktop/current-runtime.cjs`)**：
     - 定义 `PLATFORM_LAYOUTS` 与 `SUPPORTED_PLATFORMS`，支持 `win32-x64`、`darwin-arm64`、`darwin-x64` 三种平台布局，对未支持平台（如 `linux-x64`）在 `defaultPlatformId` 与 `resolvePlatformLayout` 中明确抛出断言错误。
     - 实现 `resolveProfile(appPath, expectedPlatform)`：优先加载平台专属配置 `desktop/packaging/native-profile.<platform>.json`，仅在专属配置不存在时回退至 `desktop/packaging/native-profile.json`。
  2. **库存校验、热缓存快照与父目录符号链接防护 (`verifyNativeInventory`)**：
     - 兼容库存条目可选 `owner` 字段（`bytes,path,sha256` 或 `bytes,owner,path,sha256`）。
     - 每次调用（含命中 `inventorySnapshots` 热缓存前）对 `contentDirectories` 中的每个目录执行逐级 `admitted(memberRoot, dir, true)` 校验，确保将父目录移出项目并替换为符号链接/Junction 的篡改在热缓存路径下同样被拒绝。
     - 将 `hashes` 缓存容量提升至 `65536`（FIFO 淘汰），并在 `inventorySnapshots` 中保存已验证文件的 `fileMap`（记录 `dev/ino/size/mtimeNs/ctimeNs/sha256`），确保超过 16,384 个文件的运行时在单文件时间戳更新时仅重算变更文件哈希，热缓存命中时不打开任何成员文件。
  3. **导入探针锁绑定与动态库搜索目录覆盖校验 (`developmentNative` / `developmentXtb`)**：
     - 校验 `import-probe.json`：`passed === true`、`scienceExecuted === false`、平台字段匹配（Darwin 下强制要求 `probeDoc.platform === expectedPlatform`，Windows 下允许缺省或等于 `win32-x64`），且强制校验 `probeDoc.runtimeLock`、`probeDoc.toolchainLock`、`probeDoc.xtbLock` 与 `runtime.reference`、`toolchain.reference`、`prepared.xtbLock` 严格相等；同时要求探针包含 `rdkit`、`ase`、`spglib`、`scipy`、`tblite`（或 `tblite.library`）。
     - 强制校验 `runtime` 与 `toolchain` 锁的 `contentDirectories` 完整覆盖所有非系统可执行文件与动态库搜索目录（Darwin 下覆盖 `python/bin`、`python/lib`；Windows 下覆盖 `python/Library/bin`、`python`、`python/DLLs`），防止范围过窄的 `contentDirectories` 放行 `python/lib` 下未清单化的动态库。
  4. **环境变量净化、路径分隔符注入防御与打包入口校验 (`currentRuntimeEnvironment` / `packagedBackendInfo`)**：
     - 拒绝包含不安全路径列表分隔符（POSIX 下的 `:`、Windows 盘符后的 `:` 以及所有平台下的 `;` 或 `\0`）的项目路径，防止受控路径在拼接 `PATH` 或 `DYLD_FALLBACK_LIBRARY_PATH` 时被拆分为项目外搜索目录。
     - 净化 `CONDA_*`、`_CONDA_*`、`VIRTUAL_ENV`、`PYTHON*`、`_PYTHON_*`、`_CE_CONDA`、`_CE_M`、`DYLD_*`、`LD_*`、`RDBASE` 等外部环境变量，按目标平台分隔符设置受控 `PATH` 与 Darwin `DYLD_FALLBACK_LIBRARY_PATH`。
     - `packagedBackendInfo` 按平台校验打包引擎入口文件名（Darwin 为 `engine`，Windows 为 `engine.exe`）。
- **边界与非目标 (Out of Scope)**：
  - 本分支**不修改** `desktop/runtime.cjs` 与 `scripts/native/dev-runtime.py`（Python 隔离引导器将在下一微分支 `mac/phase1a2-python-dev-bootstrap` 中独立实现与复核）。
  - 本分支**不涉及** `.local` 科学计算环境实际构建脚本（将在 `mac/phase1a3-darwin-staging` 实现）及任务进程树管理（将在 `mac/phase1b-process-identity` 实现）。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `desktop/current-runtime.cjs`
  - `tests/desktop/current-runtime.test.mjs`
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 所有路径比较与测试断言均兼容 POSIX (`/`) 与 Windows (`\`)，目录链接测试在 Windows 下使用 `'junction'`，环境变量拼接按目标平台（`win32-x64` 使用 `;`，`darwin-*` 使用 `:`）处理。
- **关键实现逻辑与架构影响**：
  - 通过 `hasUnsafePathDelimiter`、`isDirectoryCoveredByContent`、`verifyNativeInventory` 与 `resolveProfile` 形成闭环，不改变现有对外导出函数签名。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/current-runtime.test.mjs`
- **核心验证场景与边界条件**：
  - `win32-x64`、`darwin-arm64`、`darwin-x64` 三平台 `developmentNative`、`developmentXtb`、`currentRuntimeEnvironment`、`packagedBackendInfo` 正向与篡改拦截测试；
  - 跨平台串用或锁摘要过期的 `import-probe.json` 拦截测试；
  - 同平台下 `native-profile.<platform>.json` 与 `native-profile.json` 并存时的优先级测试；
  - `contentDirectories` 过窄导致 `python/lib` 未完全覆盖并注入额外 `.dylib` 时的拦截测试；
  - 热缓存命中后将父目录移出项目并替换为符号链接/Junction 的拦截测试；
  - 包含冒号 `:` 或分号 `;` 的不安全项目路径拦截测试；
  - 16,506 个文件的热缓存 0 文件打开断言与单文件时间戳变更 O(1) 重算哈希测试。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 开发第一阶段让程序支持在 Mac 上运行，并在第 3 轮复核触发熔断后同意将阶段 1A-1 拆分为 `mac/phase1a1-node-runtime-contract` 与 `mac/phase1a2-python-dev-bootstrap` 两个微分支推进。
- **澄清细节与确认结论**：
  - 用户明确确认（“可以”）按微分支拆分方案推进，首先完成 `mac/phase1a1-node-runtime-contract`（仅包含 `desktop/current-runtime.cjs` 及其单元测试 `tests/desktop/current-runtime.test.mjs`）并修复全部边界问题。
- **是否已获得用户开发确认**：是
