# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：人机同屏协作 MCP 阶段 1 —— 基础 MCP 协议服务与主进程↔前端双向通信底座
- **关联分支**：`feat/mcp-foundation-bridge`
- **目标概要**：构建标准 MCP (`stdio` JSON-RPC 2.0) 服务端、Electron 主进程本机安全回环桥接层（Loopback HTTP + Bearer Token）以及主进程↔React 渲染进程双向指令/回执通道，并率先提供 `ester_ping` 与 `ester_status` 基础诊断工具，为后续 6 个阶段的业务工具提供统一通信底座。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **总体分阶段演进路线（7 阶段蓝图）**：
  - **阶段 1（本任务 `feat/mcp-foundation-bridge`）**：基础 MCP Server + 主进程↔前端双向通信底座 + `ester_ping` / `ester_status` 状态探活；
  - **阶段 2（`feat/mcp-window-and-file-tools`）**：第一类工具 —— 窗口与视图管理（`ester_window_manage`）+ 文件导入打开（`ester_open_file`）；
  - **阶段 3（`feat/mcp-viewport-and-vision-tools`）**：第二类工具 —— 3D 视口旋转/标准轴对齐/标签开关（`ester_viewport_camera`）+ 视口高清渲染截图（`ester_viewport_screenshot`）；
  - **阶段 4（`feat/mcp-structure-and-geometry-tools`）**：第三类工具 —— 深度结构与拓扑内省（`ester_get_structure_info`）、键长/键角/二面角测量与高亮（`ester_measure_geometry`）、结构编辑与冻结/扫描约束设置（`ester_edit_structure`、`ester_set_constraints`）；
  - **阶段 5（`feat/mcp-input-config-tools`）**：第四类工具 —— 量化方法学推荐（`ester_recommend_method`）+ Gaussian/ORCA 计算任务同屏配置（`ester_configure_calculation`）；
  - **阶段 6（`feat/mcp-task-execution-tools`）**：第五类工具 —— 本机 xTB/构象搜索触发（`ester_run_local_xtb`）+ 任务中心提交与监控（`ester_submit_task`、`ester_task_manage`）；
  - **阶段 7（`feat/mcp-analysis-and-export-tools`）**：第六类工具 —— 结果分析视图载入（`ester_open_result_analysis`）+ Multiwfn 电荷/键级/轨道同屏渲染（`ester_run_wavefunction_analysis`）+ 数据导出（`ester_export_artifact`）。
- **本阶段（阶段 1）核心功能需求**：
  1. **零外部依赖的标准 MCP `stdio` 协议层 (`desktop/mcp/protocol.cjs`)**：支持 MCP `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call` 请求处理与结构化响应（文本/图像/错误）封装。
  2. **Electron 主进程本机安全桥接与前端 RPC 协调器 (`desktop/mcp/live-bridge.cjs`)**：
     - 在主进程启动仅绑定 `127.0.0.1:0` 的本地控制端点，使用随机 256-bit Bearer Token 鉴权，并将连接凭据写入受限权限（`0o600`）的 `mcp-session.json`；
     - 提供主进程向权威渲染窗口派发请求（`sciyue:mcp-frontend-request`）并异步等待渲染窗口回执（`sciyue:mcp-frontend-reply`）的 Promise 协调器，支持超时保护与窗口销毁自动清理。
  3. **前端渲染进程同屏协作 Hook (`src/web/mcp/useMcpCollaborationBridge.ts`)**：
     - 通过 `desktop/preload.cjs` 暴露的安全接口监听主进程发来的 MCP 协作指令；
     - 实现基础内省指令 `frontend.ping` 与 `frontend.status`（实时返回前端当前激活模块 `module`、活动视图及打开的所有模型文档 `id` / `label` / `revision` / 原子数 / 电荷多重度摘要），并预留可扩展命令分发器。
  4. **独立 MCP 启动入口 (`desktop/mcp/stdio-server.cjs`)**：供 Claude Desktop / Antigravity / Cursor 等客户端通过 `node desktop/mcp/stdio-server.cjs` 启动，暴露 `ester_ping` 与 `ester_status` 两个基础工具。
- **边界与非目标 (Out of Scope)**：
  - 本阶段仅实现通信底座与状态探活（`ester_ping`、`ester_status`），不实现具体的窗口切换、文件导入、3D 截图、结构编辑或任务提交业务逻辑（归属阶段 2–7）；
  - 不引入任何第三方 npm 运行时依赖，完全基于 Node.js 原生模块（`node:http`、`node:readline`、`node:crypto`、`node:fs`）实现。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `docs/MCP_COLLABORATION_ROADMAP.md`（新增：持久化保存全部 7 个开发阶段与 6 大类 16+ 个 MCP 工具的完整蓝图，防止跨会话或上下文压缩遗忘）
  - `desktop/mcp/protocol.cjs`（新增：MCP JSON-RPC 2.0 协议解析、工具注册表与 Schema 描述）
  - `desktop/mcp/live-bridge.cjs`（新增：主进程 `createMcpLiveHost`、客户端 `createMcpLiveClient` 及前端请求-回执状态机）
  - `desktop/mcp/stdio-server.cjs`（新增：标准 `stdio` MCP Server 进程入口）
  - `desktop/main.cjs`（修改：挂载 `mcpLiveHost` 与 `sciyue:mcp-frontend-reply` IPC 处理，退出时清理 `mcp-session.json`）
  - `desktop/preload.cjs`（修改：暴露 `onMcpFrontendRequest` 与 `replyMcpFrontendRequest` 安全桥接函数）
  - `src/modeling/contracts.ts`（修改：在 `DesktopBridge` 接口补充 MCP 前端协作桥接类型声明）
  - `src/web/mcp/useMcpCollaborationBridge.ts`（新增：前端 MCP 指令监听、状态快照采集与回执发送）
  - `src/web/modeling/WorkspaceShell.tsx`（修改：挂载 `useMcpCollaborationBridge`）
  - `scripts/release/application-files.json`（修改：将 `desktop/mcp/*.cjs` 纳入发布打包文件白名单）
  - `package.json`（修改：新增 `"mcp:server": "node desktop/mcp/stdio-server.cjs"` 脚本）
- **跨平台适配考量（macOS / Windows / Linux）**：
  - 采用 `127.0.0.1:0` 本地回环端口 + `mcp-session.json`（替代在 Windows 下路径与权限语义存在差异的 Unix Domain Socket），确保在 macOS (`darwin-arm64`/`darwin-x64`)、Windows (`win32-x64`) 和 Linux 上行为 100% 一致；
  - `stdio` 流统一按 UTF-8 `\n` 行分隔处理，兼容 CRLF。
- **关键实现逻辑与架构影响**：
  - 严格遵守 `preload.cjs` 安全边界：不向渲染进程暴露原始 `ipcRenderer` 或 Node 对象，仅允许对带有有效 `requestId` 的受控动作进行请求与回执；
  - 当桌面端窗口尚未打开或连接断开时，`ester_status` 仍可优雅返回 `{ desktopConnected: false }` 提示，而不导致 MCP 进程崩溃。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/mcp-foundation-bridge.test.mjs`（Node.js 端到端协议、鉴权、主进程↔模拟前端窗口双向 RPC 及 `stdio-server` 集成测试）
  - `tests/web/modeling/mcp-collaboration-bridge.test.ts`（Vitest 前端指令分发与工作台状态快照采集测试）
- **核心验证场景与边界条件**：
  1. MCP `initialize`、`ping`、`tools/list` 协议握手与工具 Schema 完整性；
  2. `createMcpLiveHost` ↔ `createMcpLiveClient` 鉴权校验（拒绝无 Token 或错误 Token 的本地请求）；
  3. `ester_ping` 与 `ester_status` 全链路穿透测试（`stdio-server` → `live-bridge` → 主进程 → 模拟渲染窗口 `onMcpFrontendRequest` → `replyMcpFrontendRequest` → 返回实时打开的文档列表与模块状态）；
  4. 渲染窗口未就绪、请求超时或窗口中途关闭时的错误恢复与资源释放；
  5. 每个阶段完成后，启动独立子代理（Subagent）执行实际工具调用验证与 `code-review` 盲审。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - 希望构建面向“人机同屏协作”的 MCP 封装层（AI 调 MCP 读取文件、配置任务、启动任务、分析结果，同时用户在前端实时看到结构、任务配置与任务中心状态，并增加窗口管理、旋转截图供 AI 视觉检查、键长/键角/二面角等深度结构内省能力）；
  - 要求分多个阶段稳扎稳打推进：第一阶段实现基础 MCP 和前端通信，第二阶段实现第一类工具，第三阶段实现第二类工具……每阶段启动子 Agent 进行测试与复核。
- **澄清细节与确认结论**：
  - 已将完整计划拆分为 7 个渐进阶段，持久化记录于 `docs/MCP_COLLABORATION_ROADMAP.md`，并在本文件中完成「阶段 1：基础 MCP 协议服务与主进程↔前端双向通信底座 (`feat/mcp-foundation-bridge`)」的技术方案与测试计划制定。
- **是否已获得用户开发确认**：是
