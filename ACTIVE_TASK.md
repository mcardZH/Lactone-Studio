# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：人机同屏协作 MCP 阶段 2 —— 第一类工具（窗口与视图管理 `ester_window_manage` + 文件导入打开 `ester_open_file`）
- **关联分支**：`feat/mcp-window-and-file-tools`
- **目标概要**：在阶段 1 建立的 MCP 协议与主进程↔前端双向通信底座之上，实现第一类同屏协作工具 `ester_window_manage` 与 `ester_open_file`，使 AI Agent 能够控制工作台模块切换、标签页管理、任务中心开关、视口平铺布局，并将本地化学结构或量化输出文件直接导入前端工作台同屏展示。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **窗口、模块与文档标签页管理工具 (`ester_window_manage`)**：
     - 支持 `action`：
       - `'list'`：查询当前窗口、激活模块、任务中心开关、多视口排布模式（`deckMode` / `multiMode`）及全部打开文档列表；
       - `'switch-module'`：切换工作台模块（`modeling` / `advanced-modeling` / `input` / `advanced` / `analysis`），并在进入具体模块时自动关闭任务中心遮罩；
       - `'activate-document'`：按 `documentId` 或 `label` 激活对应文档标签页；
       - `'create-document'`：新建空白建模文档标签页（支持可选 `label`）并自动激活；
       - `'close-document'`：按 `documentId` 关闭指定文档标签页（默认保护未保存修改，传 `discardUnsaved: true` 时允许强制丢弃关闭）；
       - `'open-task-center'` / `'close-task-center'`：打开或关闭前端「任务中心（Task Center）」视图；
       - `'set-layout'`：切换视口布局模式（`single` / `tiled` / `free`）并支持触发自动排列（`arrange: true`）；
       - `'focus-window'`：在 Electron 主进程将目标工作台窗口恢复并置顶聚焦。
  2. **本地结构与量化结果文件导入工具 (`ester_open_file`)**：
     - 支持参数 `{ path: string, target?: 'auto' | 'modeling' | 'analysis', label?: string }`；
     - 在主进程校验本地文件路径（拒绝空路径、目录或符号链接，验证文件可读性），并通过主进程安全读取或 `launchSources` 流式凭据将文件送入前端导入管线；
     - 在前端根据 `target`（`auto` 自动按文件扩展名/内容分流为结构建模或结果分析，避免弹出阻塞式模态选择框）完成解析、成键感知与文档创建，自动激活新标签页，并返回新建文档的 `documentId`、`label`、化学式（`formula`）、原子数、化学键数、电荷、自旋多重度与周期性信息。
- **边界与非目标 (Out of Scope)**：
  - 本阶段仅实现第一类工具（`ester_window_manage`、`ester_open_file`），不实现 3D 视口旋转/截图（阶段 3）、几何测量/结构编辑/约束设置（阶段 4）、计算输入配置（阶段 5）、任务提交（阶段 6）或 Multiwfn 波函数分析（阶段 7）。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `docs/MCP_COLLABORATION_ROADMAP.md`（修改：更新阶段 1 为已完成、阶段 2 为进行中）
  - `desktop/mcp/protocol.cjs`（修改：新增 `registerWindowAndFileTools` 注册 `ester_window_manage` 与 `ester_open_file` 工具定义及参数校验）
  - `desktop/mcp/live-bridge.cjs`（修改：在 `createMcpLiveHost` 中实现 `window-manage` 与 `open-file` 动作路由、本地文件安全读取与 `launchSources` 凭据桥接）
  - `desktop/main.cjs`（修改：向 `createMcpLiveHost` 注入 `focusTargetWindow` 与 `openLaunchSource` 能力）
  - `src/web/mcp/useMcpCollaborationBridge.ts`（修改：实现 `frontend.windowManage` 与 `frontend.openFile` 处理器、化学式统计与 `ScientificSourceFile` 构造器）
  - `src/web/modeling/WorkspaceShell.tsx`（修改：向 `useMcpCollaborationBridge` 注入模块导航、任务中心开关、文档关闭、视口布局及 `importFiles` 回调）
  - `tests/desktop/mcp-foundation-bridge.test.mjs`（修改：新增 `ester_window_manage` 与 `ester_open_file` 协议、文件校验与跨进程端到端测试）
  - `tests/web/modeling/mcp-collaboration-bridge.test.ts`（修改：新增前端窗口管理与结构文件导入测试）
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 文件路径解析统一通过 `path.resolve` 处理，并在主进程通过 `fs.lstat` + `fs.stat` 校验普通文件身份；
  - 文本编码统一采用 UTF-8（兼容 CRLF 换行符的 `.xyz` / `.gjf` / `.inp` / `.cif` / `.pdb` / `.mol` / `.sdf` 文件）。
- **关键实现逻辑与架构影响**：
  - `ester_open_file` 的文件路径只在 Electron 主进程（`desktop/mcp/live-bridge.cjs`）中验证并打开，遵循“渲染进程不直接访问任意文件系统路径”的安全边界；
  - 当 `WorkspaceShell.tsx` 挂载时，优先调用其完整 `importFiles` 管线（含经验成键感知与后处理分析接入）并支持自定义 `label` 重命名。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/mcp-foundation-bridge.test.mjs`
  - `tests/web/modeling/mcp-collaboration-bridge.test.ts`
- **核心验证场景与边界条件**：
  1. `ester_window_manage` 的 `list`、`switch-module`、`create-document`、`activate-document`、`close-document`（含未保存修改拦截与 `discardUnsaved: true` 强制关闭）、`open-task-center`、`close-task-center`、`set-layout`、`focus-window` 全动作验证；
  2. `ester_open_file` 导入 `.xyz`、`.gjf`、`.cif` 等结构文件自动创建文档、计算化学式、感知化学键并返回完整结构摘要；
  3. `ester_open_file` 对不存在的文件、目录或非法参数的错误拦截；
  4. 启动独立子代理（Subagent）执行阶段 2 工具端到端实测与 4 子代理 `code-review` 盲审。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 确认合并阶段 1 分支后，开始开发第二阶段（第一类工具：`ester_window_manage` 窗口管理与 `ester_open_file` 文件读取导入）。
- **澄清细节与确认结论**：
  - 严格按照 `docs/MCP_COLLABORATION_ROADMAP.md` 中阶段 2 的规划推进，完成后同样启动功能测试子代理与 `code-review` 多子代理复核。
- **是否已获得用户开发确认**：是
