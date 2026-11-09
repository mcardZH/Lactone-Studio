# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：项目重命名为 Lactone Studio (LS)、落实许可协议非官方修改版合规声明并重写开源文档
- **关联分支**：`chore/rebrand-lactone-studio`
- **目标概要**：依据《Ester Studio（ES）免费源码公开许可协议 1.0》（`LICENSE.txt` 第七条、第三条、第五条、第八条）及用户确认的新项目名 **Lactone Studio**，更新产品名称与版本元数据、补充程序内“关于与版本信息”及非官方修改版显著标识，并重写 `README.md`、`BUILDING.md`、`CONTRIBUTING.md` 等开源说明文档，随后在 GitHub 创建仓库并推送 `main` 分支。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **产品标识与修改版元数据 (`package.json` & `src/application-version.ts`)**：
     - 将 `package.json` 的 `productName` 更新为 `"Lactone Studio"`，并新增结构化 `modificationNotice` 元数据（标注 `unofficialModification: true`、修改版名称 `Lactone Studio (LS)`、修改版本号 `2.0.3-lactone.1`、修改者 `mcardZH`、对应源码仓库 `https://github.com/mcardZH/Lactone-Studio` 以及上游 `Ester Studio v2.0.3` 来源信息）；
     - 在 `src/application-version.ts` 中导出 `productName`、`shortName` 与 `modificationNotice`，确保前端与版本说明可统一读取。
  2. **程序内“关于”页面、窗口标题与首次运行协议弹窗合规标识（`LICENSE.txt` 第七条）**：
     - 更新 `index.html`、`desktop/main.cjs` 主窗口标题、`src/web/App.tsx` 品牌栏/页脚、`src/web/modeling/WorkspaceShell.tsx` 导航栏标识（`LS`）及 `src/web/FirstRunLicense.tsx` 首次运行协议弹窗标题，显著标注 `Lactone Studio（基于 Ester Studio 的非官方修改版）`；
     - 在全局设置面板 `src/web/modeling/SettingsPanel.tsx` 中新增 **「关于与版本」(`about`)** 页面，显著展示“非官方修改版”声明、修改者 `mcardZH`、修改版本号 `2.0.3-lactone.1`、对应源码地址 `https://github.com/mcardZH/Lactone-Studio`、上游官方项目信息及科研引用要求。
  3. **重写 `README.md` 及配套说明文档 (`BUILDING.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/*.md`)**：
     - 编写完整的开源版 `README.md`：顶部显著位置展示非官方修改版合规声明（第七条），详细介绍 Lactone Studio 的科学计算功能、macOS (`darwin-arm64` / `darwin-x64`) 原生适配架构、MCP 人机同屏协作底座、快速开始与构建打包指南、科研引用规范（第八条）及许可证说明（第三条、第五条、第十条）；
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
  - `scripts/release/package-macos.mjs`（更新 CLI 构建日志输出以动态反映 `productName`）
  - `README.md`、`BUILDING.md`、`CONTRIBUTING.md`、`AGENTS.md`、`docs/PROJECT_STRUCTURE.md`、`docs/MACOS_PORTING_ROADMAP.md`（重写项目文档与合规声明）
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 所有品牌与合规信息通过 `package.json` 与 `src/application-version.ts` 纯数据层驱动，不依赖任何特定操作系统 API，在 macOS (`darwin-arm64`/`darwin-x64`)、Windows (`win32-x64`) 与 Linux 下表现一致；
  - `scripts/release/package-macos.mjs` 读取 `package.json` 的 `productName` 自动生成 `Lactone Studio.app` 与 `Lactone-Studio-2.0.3-darwin-<arch>.dmg`，同时保留未指定 `productName` 时的回退默认值以兼容既有单测。
- **关键实现逻辑与架构影响**：
  - 严格遵守 `LICENSE.txt` 第七条第 1、2、3 款要求，确保在下载/发布介绍（`README.md`）、程序“关于”页面（`SettingsPanel.tsx` 的 `about` 页）、首次运行协议页（`FirstRunLicense.tsx`）及版本信息（`applicationVersion`）中均显著呈现“非官方修改版”标识。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/web/application-version-lactone.test.ts`（新增：验证 `applicationVersion`、`SettingsPanel`「关于与版本」页面、`FirstRunLicense` 及 `README.md` 包含完整的 `Lactone Studio` 名称与协议第七条要求的非官方修改版标识、修改者、版本号及源码地址）
  - `tests/desktop/package-macos.test.mjs`（更新：验证 `package.json` 的 `Lactone Studio` 产品名、`desktop/main.cjs` 窗口标题及 `package-macos.mjs` 打包兼容性）
- **核心验证场景与边界条件**：
  1. 校验 `package.json` 与 `applicationVersion` 导出的 `productName` (`Lactone Studio`)、`shortName` (`LS`) 及 `modificationNotice` 字段完整性；
  2. 校验 `SettingsPanel` 切换到 `about`（关于与版本）标签页时，DOM 正确渲染“非官方修改版”、修改者 `mcardZH`、修改版本 `2.0.3-lactone.1`、源码仓库 URL `https://github.com/mcardZH/Lactone-Studio` 及上游 `Ester Studio` 致谢与引用提示；
  3. 校验全量单元测试套件（`npm test`）100% 通过。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 根据软件协议，需要为项目起一个新名字并显著标注非官方修改版后开源发布；确认选定新名称后，在用户 GitHub (`mcardZH`) 创建新仓库，重新编写 `README.md` 文档和相关说明，并先推送 `main` 分支。
- **澄清细节与确认结论**：
  - 用户从候选方案中明确选定 **Lactone Studio** 作为新项目名称，并确认先推送 `main` 分支，其余本地开发分支暂不推送；
  - 保持 `.es` / `.sy` 工程文件格式、底层 IPC 通道与科学文献引用注册表兼容，避免破坏上游三方同步能力。
- **是否已获得用户开发确认**：是
