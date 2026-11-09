# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：项目重命名为 Lactone Studio (LS)、生成专属应用图标、内置打包安装说明、配置 GitHub Actions 自动编译分发 macOS App 并重写开源文档
- **关联分支**：`chore/rebrand-lactone-studio`
- **目标概要**：依据《Ester Studio（ES）免费源码公开许可协议 1.0》（`LICENSE.txt` 第七条、第三条、第五条、第八条）及用户确认的新项目名 **Lactone Studio**，更新产品名称与版本元数据、补充程序内“关于与版本信息”及非官方修改版显著标识、生成专属品牌图标并嵌入 `.app`、在编译打包时自动生成并附带 `安装说明 (INSTALL).txt`、配置 `.github/workflows/release-macos.yml` 实现自动编译与分发 macOS App，并重写 `README.md` 等开源说明文档，随后在 GitHub 创建仓库并推送 `main` 分支。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **产品标识与修改版元数据 (`package.json` & `src/application-version.ts`)**：
     - 将 `package.json` 的 `productName` 更新为 `"Lactone Studio"`，并新增结构化 `modificationNotice` 元数据（标注 `unofficialModification: true`、修改版名称 `Lactone Studio (LS)`、修改版本号 `2.0.3-lactone.1`、修改者 `mcardZH`、对应源码仓库 `https://github.com/mcardZH/Lactone-Studio` 以及上游 `Ester Studio v2.0.3` 来源信息）；
     - 在 `src/application-version.ts` 中导出 `productName`、`shortName` 与 `modificationNotice`，确保前端与版本说明可统一读取。
  2. **程序内“关于”页面、窗口标题与首次运行协议弹窗合规标识（`LICENSE.txt` 第七条）**：
     - 更新 `index.html`、`desktop/main.cjs` 主窗口标题、`src/web/App.tsx` 品牌栏/页脚、`src/web/modeling/WorkspaceShell.tsx` 导航栏标识（`LS`）及 `src/web/FirstRunLicense.tsx` 首次运行协议弹窗标题，显著标注 `Lactone Studio（基于 Ester Studio 的非官方修改版）`；
     - 在全局设置面板 `src/web/modeling/SettingsPanel.tsx` 中新增 **「关于与版本」(`about`)** 页面，显著展示“非官方修改版”声明、修改者 `mcardZH`、修改版本号 `2.0.3-lactone.1`、对应源码地址 `https://github.com/mcardZH/Lactone-Studio`、上游官方项目信息及科研引用要求。
  3. **专属项目图标生成与 `.app` 嵌入 (`public/favicon.svg`, `public/brand-icon.png`, `scripts/portable/assets/lactone.icns`)**：
     - 设计并生成体现内酯环（五元环内酯 + 羰基双键 + 分子轨道与 `LS` 字样）的专属应用图标：包含矢量图标 `public/favicon.svg`、高清位图 `public/brand-icon.png`、macOS 多分辨率图标包 `scripts/portable/assets/lactone.icns`（16px–1024px）以及 Windows 便携版图标 `scripts/portable/assets/sciyue.ico`（同步更新 `scripts/portable/assets/source.json` 哈希校验值）；
     - 在 `scripts/prepare-chemistry.mjs` 中将 `brand-icon.png` 纳入桌面静态资源列表，并在 `scripts/release/package-macos.mjs` 打包时自动将 `lactone.icns` 写入 `Lactone Studio.app/Contents/Resources/electron.icns`。
  4. **打包编译时自动生成并内置 macOS 安装说明 (`scripts/release/package-macos.mjs`)**：
     - 新增 `buildMacInstallGuideText()` 函数，在执行 `npm run package:mac` 时自动在 `release/darwin-<arch>/安装说明 (INSTALL).txt` 以及 `.dmg` 镜像根目录内生成安装与使用说明（涵盖拖拽安装步骤、`sudo xattr -rd com.apple.quarantine` 首次启动解除 macOS Gatekeeper 隔离指南、内置 Python 3.12 + xTB 说明、非官方修改版合规声明与科研引用提示）。
  5. **GitHub Actions 自动编译与分发 macOS App (`.github/workflows/release-macos.yml`)**：
     - 编写 `.github/workflows/release-macos.yml`，支持推送 `v*` 标签或手动 `workflow_dispatch` 触发；
     - 在 `macos-15` (Apple Silicon `arm64`) 运行器上自动配置 Node.js 24 与 Miniforge (`conda-forge` Python 3.12 + RDKit + ASE + Spglib + tblite + SciPy + NumPy + GNU xTB 6.4.1)，执行 `stage-darwin-runtime.mjs`、`npm run prepare:runtime` 与 `npm run package:mac`，生成 `.dmg`、`.app.zip`、`安装说明 (INSTALL).txt` 与 `SHA256SUMS.txt`，自动上传至 GitHub Actions Artifacts 并在标签/指定版本触发时自动发布到 GitHub Releases。
  6. **重写 `README.md` 及配套说明文档 (`BUILDING.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/*.md`)**：
     - 编写完整的开源版 `README.md`：顶部显著位置展示非官方修改版合规声明（第七条），详细介绍 Lactone Studio 的科学计算功能、macOS (`darwin-arm64` / `darwin-x64`) 原生适配架构、GitHub Actions 自动编译分发与安装说明、MCP 人机同屏协作底座、快速开始与构建打包指南、科研引用规范（第八条）及许可证说明；
     - 同步更新 `BUILDING.md`、`CONTRIBUTING.md`、`AGENTS.md`、`docs/PROJECT_STRUCTURE.md` 与 `docs/MACOS_PORTING_ROADMAP.md` 中的项目名称与背景说明。
- **边界与非目标 (Out of Scope)**：
  - **不修改** `.es` / `.sy` 工程文件扩展名、内部 schema 标识符（如 `sciyue-*`）、量化输入/输出文件头注释（如 `Ester Studio explicit coordinates`）或 `src/citations/collect.ts` 中对原版 `Ester Studio` 的文献引用锚点（遵循协议第八条第 5 款且确保与上游源码快照 100% 兼容）；
  - **不改动** `LICENSE.txt` 原文及 `licenses/` 下的第三方许可证文本（遵循协议第三条第 1 款）。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `package.json`（更新 `productName` 为 `"Lactone Studio"`，新增 `modificationNotice` 元数据）
  - `src/application-version.ts`（导出 `productName`、`shortName`、`modificationNotice` 结构化对象）
  - `index.html`（更新页面标题与描述为 `Lactone Studio`）
  - `desktop/main.cjs`（更新主窗口默认标题为 `Lactone Studio v...（非官方修改版）`）
  - `src/web/App.tsx`（更新侧栏品牌标识为 `LS` / `Lactone Studio` 及页脚非官方修改版说明）
  - `src/web/FirstRunLicense.tsx`（在许可协议阅读窗口头部显著标注 `Lactone Studio · 非官方修改版` 与源码地址）
  - `src/web/modeling/WorkspaceShell.tsx`（更新左侧模块导航栏全局设置按钮标识为 `LS` 及提示文案）
  - `src/web/modeling/SettingsPanel.tsx`（新增 `about`「关于与版本」分类页，完整呈现协议第七条要求的非官方修改版声明、修改者、版本号、源码链接与第八条科研引用说明）
  - `public/favicon.svg`、`public/brand-icon.png`、`scripts/portable/assets/lactone.icns`、`scripts/portable/assets/sciyue.ico`、`scripts/portable/assets/source.json`（专属 Lactone Studio 品牌图标与哈希清单）
  - `scripts/prepare-chemistry.mjs`（将 `brand-icon.png` 加入 `desktopPublicEntries`）
  - `scripts/release/package-macos.mjs`（自动嵌入 `lactone.icns` 图标，生成并在输出目录及 `.dmg` 中内置 `安装说明 (INSTALL).txt`）
  - `.github/workflows/release-macos.yml`（GitHub Actions 自动构建 `.app` / `.dmg` 并发布 GitHub Release）
  - `README.md`、`BUILDING.md`、`CONTRIBUTING.md`、`AGENTS.md`、`docs/PROJECT_STRUCTURE.md`、`docs/MACOS_PORTING_ROADMAP.md`（重写项目文档与合规声明）
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 所有品牌与合规信息通过 `package.json` 与 `src/application-version.ts` 纯数据层驱动，不依赖任何特定操作系统 API，在 macOS (`darwin-arm64`/`darwin-x64`)、Windows (`win32-x64`) 与 Linux 下表现一致；
  - `scripts/release/package-macos.mjs` 读取 `package.json` 的 `productName` 自动生成 `Lactone Studio.app`、`Lactone-Studio-2.0.3-darwin-<arch>.dmg` 及 `安装说明 (INSTALL).txt`，同时保留未指定 `productName` 时的回退默认值以兼容既有单测。
- **关键实现逻辑与架构影响**：
  - 严格遵守 `LICENSE.txt` 第七条第 1、2、3 款要求，确保在下载/发布介绍（`README.md`、`安装说明 (INSTALL).txt`）、程序“关于”页面（`SettingsPanel.tsx` 的 `about` 页）、首次运行协议页（`FirstRunLicense.tsx`）及版本信息（`applicationVersion`）中均显著呈现“非官方修改版”标识。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/web/application-version-lactone.test.ts`（验证 `applicationVersion`、`SettingsPanel`「关于与版本」页面、`FirstRunLicense`、`README.md`、图标资产及 `.github/workflows/release-macos.yml` 完整性）
  - `tests/desktop/package-macos.test.mjs`（验证 `package.json` 的 `Lactone Studio` 产品名、`prepare-chemistry.mjs` 的 `brand-icon.png`、`package-macos.mjs` 的 `.icns` 图标嵌入与 `安装说明 (INSTALL).txt` 生成及 DMG 暂存区写入）
- **核心验证场景与边界条件**：
  1. 校验 `package.json` 与 `applicationVersion` 导出的 `productName` (`Lactone Studio`)、`shortName` (`LS`) 及 `modificationNotice` 字段完整性；
  2. 校验 `SettingsPanel` 切换到 `about`（关于与版本）标签页时，DOM 正确渲染“非官方修改版”、修改者 `mcardZH`、修改版本 `2.0.3-lactone.1`、源码仓库 URL `https://github.com/mcardZH/Lactone-Studio` 及上游 `Ester Studio` 致谢与引用提示；
  3. 校验 `assembleMacAppBundle` 自动复制 `lactone.icns` 至 `Contents/Resources/electron.icns`，并在输出目录与 `.dmg` 镜像内写入 `安装说明 (INSTALL).txt`；
  4. 校验全量单元测试套件（`npm test`）100% 通过。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 根据软件协议，为项目起名为 **Lactone Studio** 并显著标注非官方修改版后开源发布；
  - 新增三个需求：① 配置 GitHub Actions 自动编译 macOS App 并自动分发；② 为项目生成专属图标并在编译时嵌入 App；③ 在打包编译时生成并附带一份安装说明；
  - 完成后在用户 GitHub (`mcardZH`) 创建新仓库，先推送 `main` 分支。
- **澄清细节与确认结论**：
  - 用户确认自动编译分发目标为 **macOS App**（`.app` / `.dmg`），并确认先推送 `main` 分支，其余本地开发分支暂不推送；
  - 保持 `.es` / `.sy` 工程文件格式、底层 IPC 通道与科学文献引用注册表兼容，避免破坏上游三方同步能力。
- **是否已获得用户开发确认**：是
