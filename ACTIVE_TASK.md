# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段 1A-2：macOS Darwin 本地科学运行时制备管线、锁文件与核心科学引擎验证（`mac/phase1a3-darwin-staging`）
- **关联分支**：`mac/phase1a3-darwin-staging`
- **目标概要**：实现可复现、无损回滚、前缀无关的 macOS `.local` 科学计算环境制备脚本 `scripts/native/stage-darwin-runtime.mjs`，生成 `darwin-arm64` 锁文件与 profile（`desktop/packaging/*.darwin-arm64*.json`），并通过真实 macOS 科学计算引擎测试（`tests/desktop/chemistry/engine-macos.test.mjs`）验证 RDKit、ASE、Spglib、tblite、SciPy 及 xTB 周期性键级与晶体建模能力。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **macOS `.local` 运行时制备脚本 (`scripts/native/stage-darwin-runtime.mjs` & `npm run native:stage:darwin`)**：
     - `resolveDefaultCondaPrefix`：优先读取 `SCIYUE_CONDA_ENV`，忽略 `base` 环境，回退至专用 `ester-studio` Conda 环境路径。
     - `verifyMachOArchitecture`：校验薄二进制与胖二进制（Universal 2）Mach-O 头部架构是否匹配目标 `darwin-arm64` / `darwin-x64`。
     - 事务性制备与回滚：在临时目录完成 Python 工具链、科学依赖（`rdkit`, `ase`, `spglib`, `tblite`, `scipy`）与 `xtb`（含必需动态库与参数文件）的解引用复制、Mach-O/文本前缀归一化重定位（`CANONICAL_LOCKED_PREFIX`）、RDKit `share/RDKit/Data` 数据目录内聚重定位、`__pycache__`/`*.pyc`/`*.orig`/`CTestTestfile.cmake` 清理、Mach-O 架构校验、`xtb --version` 可执行性校验及真实 `dev-runtime.py` 隔离导入探测后，再原子替换至 `.local/` 并设为只读权限；任何中途失败均无损保留既有 `.local/` 状态。
     - 锁文件校验与更新：支持 `--update-locks` 生成/更新 `desktop/packaging/native-profile.darwin-arm64.json`、`native-runtime.darwin-arm64.lock.json`、`native-toolchain.darwin-arm64.lock.json`、`xtb-runtime.darwin-arm64.lock.json`，并在默认模式下校验生成产物与已提交锁文件零漂移（`STAGE_LOCK_DRIFT`）。
  2. **macOS 科学引擎端到端验证 (`tests/desktop/chemistry/engine-macos.test.mjs`)**：
     - 验证通过 `chemistryRuntime` 与 `currentRuntimeEnvironment` 启动锁定开发态 Python 科学引擎；
     - 验证 `engine.py --capabilities`（`periodicGfn2BondOrders: true`、`tbliteVersion`）；
     - 验证 `generate3d`（ETKDGv3）、`optimize`（力场优化）、`perceive-bonds`、`convert`（XYZ/SDF）；
     - 验证 `--crystal-modeling`（Spglib 空间群对称性识别与 ASE 超胞构建）；
     - 验证 `desktop/chemistry` 全部核心子模块导入、RDKit `RDDataDir` 指向锁定运行时内部，且进程加载的 `libRDKit`/`libtblite`/`libsymspg` 动态库严格位于锁定 `.local/dependencies` 目录内。
- **边界与非目标 (Out of Scope)**：
  - 本分支**不涉及**任务系统 POSIX/macOS 进程组与生命周期控制（将在下一分支 `mac/phase1b-process-identity` 实现）。
  - 本分支**不涉及** `darwin-x64` 锁文件生成（当前宿主为 Apple Silicon `darwin-arm64`，`darwin-x64` 锁文件将在对应架构环境制备）。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `scripts/native/stage-darwin-runtime.mjs`
  - `desktop/packaging/native-profile.darwin-arm64.json`
  - `desktop/packaging/native-runtime.darwin-arm64.lock.json`
  - `desktop/packaging/native-toolchain.darwin-arm64.lock.json`
  - `desktop/packaging/xtb-runtime.darwin-arm64.lock.json`
  - `package.json`
  - `tests/native/stage-darwin-runtime.test.mjs`
  - `tests/desktop/chemistry/engine-macos.test.mjs`
  - `tests/native/dev-runtime.test.mjs`（为 `populateMinimalBootStdlib` 补充 `os.py` 标准库地标文件，兼容重定位后的 `.local` Python 二进制）
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 保留原有 `win32-x64` 默认锁文件不变，新增 `.darwin-arm64.json` 平台专属锁文件与 profile。
- **关键实现逻辑与架构影响**：
  - 通过将 Conda 构建期前缀在 Mach-O 字符串槽位与文本配置中重定位为固定长度的 `CANONICAL_LOCKED_PREFIX`（若槽位长度不足或存在残留前缀则显式抛出 `STAGE_RELOCATION_FAILED`），并对重定位后的 Mach-O 二进制重新执行 ad-hoc `codesign` 签名、保持 `@rpath`/`@loader_path` 与受控 `DYLD_FALLBACK_LIBRARY_PATH` 解析，确保不同机器或不同 Conda 路径下制备出的二进制哈希 100% 一致。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/native/stage-darwin-runtime.test.mjs`
  - `tests/desktop/chemistry/engine-macos.test.mjs`
- **核心验证场景与边界条件**：
  - 不同长度 Conda 路径下的前缀无关可复现性测试（`updateLocks: false` 零漂移）；
  - 架构不匹配、伪造 `xtb` 二进制、缺失 `scipy` 模块、文件内容篡改下的非破坏性回滚与只读权限保持测试；
  - 真实 macOS 科学计算引擎 `generate3d`、`optimize`、`perceive-bonds`、`convert`、`--crystal-modeling` 与动态库加载路径隔离验证。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 在合并 `mac/phase1a2-python-dev-bootstrap` 后，进入下一阶段分支 `mac/phase1a3-darwin-staging`。
- **澄清细节与确认结论**：
  - 用户已明确确认合并 `mac/phase1a2-python-dev-bootstrap` 并进入 `mac/phase1a3-darwin-staging` 分支开发。
- **是否已获得用户开发确认**：是
