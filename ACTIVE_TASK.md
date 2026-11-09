# ACTIVE_TASK.md — 当前开发任务规格说明书 (Current Task Specification)

## 1. 任务概述 (Task Overview)

- **任务名称**：同步并合并上游 Ester Studio v2.0.3 源码快照与 macOS 增量适配
- **关联分支**：`mac/upstream-v2.0.3`
- **当前状态**：`CONFIRMED`
- **核心目标**：基于共同祖先 `ab563fb0`（`upstream/v2.0.2`）将上游 `upstream/v2.0.3`（`3571e043`）三方合并入本仓，保留全部既有 macOS 适配逻辑（Darwin Python/xTB 运行时锁定、MolVec OCR、Multiwfn CLI、远程 SSH/Slurm 环境筛选、macOS `.app`/`.dmg` 打包），并对 `v2.0.3` 新增的构象隐式溶剂化（`conformer_solvation.py` / `src/data/conformer-solvation.json`）及原生 MD 引擎身份校验（`conformer_native_md.py`）完成 macOS 兼容性适配与测试验证。

---

## 2. 需求细节与范围边界 (Requirements & Scope Boundary)

### 2.1 核心功能点 (In Scope)
- [x] **合入分类 A（仅上游修改文件，共 115 个）**：
  - 构象采样隐式溶剂化（ALPB 12 种预设溶剂，支持 GFN-FF / GFN1-xTB / GFN2-xTB 分子动力学与元动力学，含 `src/data/conformer-solvation.json`、`desktop/conformer-solvation.cjs`、`desktop/chemistry/conformer_solvation.py`）；
  - 球形势阱 3D 蓝色线框球预览与实时调参反馈（`src/web/modeling/Viewport3D.tsx`、`src/web/conformer-sampling-sphere-preview.ts`）；
  - 冻结状态与构象/高级功能抽屉双向同步（`src/web/modeling/workspace-freeze-policy.ts`）；
  - 等价构象智能归并（`src/modeling/conformers/equivalence-clustering.ts`）与能量单位切换（`kcal/mol` / `kJ/mol`）；
  - 原生 MD 初始速度上限保护诊断读取（`initial_velocity_correction`）。
- [x] **核查并保留分类 B（双方共改重叠文件，共 1 个）**：
  - `package.json`：升版至 `"version": "2.0.3"` / `"displayVersion": "2.0.3"`，同时完整保留本仓 `native:stage:darwin`、`package:mac`、`review:prepare`、`review:receipt`、`upstream:*` 等脚本。
- [x] **适配分类 C 及 `v2.0.3` 新增模块的 macOS 兼容性**：
  - `desktop/chemistry/conformer_solvation.py`：新增 `_resolve_capability_path()`，兼容开发态（`src/data/conformer-solvation.json`）、macOS `.app` 打包态（`Contents/Resources/chemistry/conformer-solvation.json` 及 `Contents/Resources/app/src/data/conformer-solvation.json`）与 PyInstaller 冻结态；
  - `desktop/chemistry/conformer_native_md.py`：在 `MD_ENGINE_IDENTITIES` 与 `admitted_md_engine_identity` 中支持 macOS (`sys.platform == 'darwin'`) 经 `desktop/xtb-runtime.cjs` 校验的 `sciyue-xtb-engine-identity/v1` 运行时（同时兼容开发态锁定二进制与 `.app` 打包后经 `codesign` 签名的二进制），并在非 Darwin 平台严格保持原有精确字典匹配；
  - `scripts/release/package-macos.mjs`：默认从 `package.json` 读取 `version`（`2.0.3`），当仓库包含 `conformer-solvation.cjs` 或 `conformer_solvation.py` 时强校验 `src/data/conformer-solvation.json` 存在并将其同步复制到 `Contents/Resources/app/src/data/conformer-solvation.json` 与 `Contents/Resources/chemistry/conformer-solvation.json`。

### 2.2 非目标边界 (Out of Scope)
- 上游 `scripts/native/compose-xtb-initial-velocity.py`、`scripts/native/rebuild-xtb-initial-velocity.py`、`scripts/release/admit-built-xtb.py` 属于上游 Windows x64 MinGW 离线构建辅助脚本，不在 macOS 运行时或 `package:mac` 中调用，保持上游原样即可；
- 不对与本次 `v2.0.3` 同步无关的模块做额外重构。

---

## 3. 技术设计方案 (Technical Design)

### 3.1 涉及修改或新增的文件清单
| 文件路径 | 操作类型 (`NEW`/`MOD`/`DEL`) | 修改说明 |
| :--- | :---: | :--- |
| `package.json` | `MOD` | 合并上游 `2.0.3` 版本号与本仓 macOS 构建、审查及上游同步脚本 |
| `desktop/chemistry/conformer_solvation.py` | `NEW/MOD` | 导入上游 `v2.0.3` 新增模块并增加 `_resolve_capability_path()` 支持 macOS `.app` 打包路径 |
| `desktop/chemistry/conformer_native_md.py` | `MOD` | 合入上游 `v2.0.3` 溶剂化与初速度修正逻辑，并增加 `_admitted_darwin_md_engine_identity` 支持 macOS `xtb` 运行时身份校验 |
| `scripts/release/package-macos.mjs` | `MOD` | 默认读取 `package.json` 的 `version`，并将 `src/data/conformer-solvation.json` 打包进 `Contents/Resources/app/src/data/` 与 `Contents/Resources/chemistry/` |
| `scripts/workflow/branch-policy.mjs` | `MOD` | 在 `mac/upstream-*` 三方合并提交（`isMergeInProgress`）时要求包含 `tests/` 测试用例而不对上游纯增量文件逐一要求同名测试文件 |
| `tests/desktop/chemistry/engine-macos.test.mjs` | `MOD` | 新增 `conformer_solvation`、`conformer_native_md` 模块导入与 macOS `GFN2-xTB` + `ALPB(water)` 原生 MD 实机集成测试 |
| `tests/desktop/package-macos.test.mjs` | `MOD` | 新增 `conformer-solvation.json` 打包校验与缺失拦截测试 |
| `tests/workflow/branch-policy.test.mjs` | `MOD` | 新增 `mac/upstream-*` 三方合并提交策略单测 |

---

## 4. 自动化测试计划 (Automated Test Plan)

| 测试文件路径 | 测试覆盖场景 | 预期结果 |
| :--- | :--- | :--- |
| `tests/desktop/chemistry/engine-macos.test.mjs` | `conformer_solvation` 与 `conformer_native_md` 在 macOS `darwin-arm64` 下导入并执行带 `ALPB(water)` 的 GFN2 原生 MD | 100% PASS |
| `tests/desktop/package-macos.test.mjs` | `assembleMacAppBundle` 校验并打包 `src/data/conformer-solvation.json` 到 `app/src/data/` 与 `chemistry/` | 100% PASS |
| 全量测试套件 (`npm test`) | 15 个 Node 测试文件 + Vitest 前端测试文件 | 100% PASS |

---

## 5. 用户沟通与意图确认记录 (User Intent Confirmation)

### 5.1 原始诉求与澄清结论
- **用户原始请求**：使用新建的 `upstream-sync` 工作流同步并合并上游新发布的 `v2.0.3` 版本，保留所有 macOS 适配并对新增功能做好适配。
- **澄清问题与共识**：
  1. 将 `v2.0.3` 导入 `upstream/release` 分支并基于 `upstream/v2.0.2` 执行三方合并；
  2. 完成 `v2.0.3` 新增 `conformer_solvation` 及 `conformer_native_md` 在 macOS 下的适配、单测与多子代理复核。

### 5.2 确认状态
- **用户是否已确认**：`CONFIRMED`
