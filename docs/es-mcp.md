# Ester Studio MCP

ES MCP 将本机 Agent 接入正在运行的 Ester Studio 窗口。Agent 可读取当前模型、选区和结果，也可调用与界面共用的建模、输入、分析及运行操作。用户可以在原窗编辑，Agent 再按更新后的对象和版本接续。各项操作可独立调用，下面的例子可按需要组合。

## 连接正在运行的窗口

从快捷方式或 `.es` 项目打开 ES。在 **MCP 连接** 页点击 **复制配置提示词**，把整段粘贴到本机 Agent 的对话，再提供 ES 解压目录或 `Ester-Studio.exe` 的完整路径。提示词也可从[通用配置提示词](es-agent-dock-plan.md#通用配置提示词)复制。客户端按当前版本登记 `ester_studio`，并通过 `es_connect` 和 `es_context` 验证实际连接。

授权在客户端首次连接目标窗口时进行。请在该窗口选择 **仅本次**、**记住此客户端** 或 **拒绝**。已记住的授权可在 **MCP 连接** 页移除，当前连接也可逐个断开。只有一个可用窗口时调用 `es_connect({})` 即可。若回执为 `selection_required`，从回执的 `windows` 中选择目标。`es_capabilities({"guide":true})` 返回简明的操作说明和当前窗口实际提供的工具分组。

内置助手收到随包 `harness/skills/ester-studio/SKILL.md` 的导航，可以用 `assistant_read_skill` 读取相关章节。外部 Agent 可通过 **MCP 连接** 页另存完整 Skill ZIP，解压后将包含 `SKILL.md` 与 `references/` 的 `ester-studio` 目录装到客户端支持的 Skill 位置。MCP 连接授权与 Skill 安装相互独立。

从 **终端和助手 → 终端** 打开内嵌 PowerShell，也可启动 ES 找到的 Codex、Claude Code 或 dsh。由面板启动的客户端继承当前窗口的连接目标。**内置助手 → 服务设置** 支持 DeepSeek、OpenAI、Claude、Gemini、Ollama、Kimi、GLM，以及自定义 Base URL。填写密钥并从服务获取模型，或手填模型名。自定义服务可选 Chat Completions、Responses 或 Messages 协议。对话和用于回答的工具结果通过所选服务处理。

助手对话实时显示服务返回的文本、可用的思考内容或摘要，以及实际工具与回执。**停止助手** 可中断模型请求和等待观察，已经提交的计算使用自己的运行控制。继续沿同一对话和已有运行身份处理。运行时可以把新消息排队，或用「引导」补充当前回合。自定义指令追加到内置指令后。

内置助手的历史回执或图片如果只显示 `artifactRef`，可用 `assistant_read_artifact` 在同一对话中回读，按 `nextOffset` 继续分页，或重新取得原生 PNG。此入口只读取本对话保存的回执，项目文件仍走 ES 的原生文件工具。

### 通用 stdio 客户端

标准便携包以 `runtime/Ester-Studio-host.exe` 的绝对路径为 `command`，以同包 `runtime/resources/app/desktop/mcp/stdio.cjs` 的绝对路径为 `args` 第一项。为适配器进程保留 `ELECTRON_RUN_AS_NODE=1`。适配器通过当前 Windows 用户的 `LOCALAPPDATA/Ester Studio/MCP/v1` 发现实例，经本机命名管道连接。显式配置 `ES_MCP_DISCOVERY_DIR` 时，以客户端传给适配器的目录为准。内嵌终端使用 `ES_MCP_INSTANCE_ID` 和 `ES_MCP_WINDOW_ID` 提供默认窗口。

当这套便携包尚未运行时，未指定窗口的 `es_connect({})` 可启动同包的 `Ester-Studio.exe`，并等待工作台就绪。工作台启动时保持系统焦点，连接仍沿实际授权流程。将 `--list` 加到适配器参数末尾可只列出同包已运行的窗口。配置稳定的 `--client` 名称，或保持 MCP `initialize` 中的客户端名称稳定，便于 ES 识别已记住的客户端。

适配器使用 UTF-8 JSON-RPC，每行一条消息。以下示例应依次发送，带 `id` 的请求收到回执后再发下一条。

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-es-agent","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"es_connect","arguments":{}}}
{"jsonrpc":"2.0","id":3,"method":"tools/list"}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"es_context","arguments":{}}}
```

`es_connect` 选定适配器的默认窗口。已分别批准的窗口可通过 `es_targets` 的 `{"kind":"window"}` 查询。要让一次调用指向另一个已连接窗口，可在 `tools/call` 的 `params._meta["ester-studio/window"]` 传入该窗口的 `instanceId` 和 `windowId`。从一个项目打开另一个项目时，按 `es_project` 回执的窗口标识连接实际项目窗口。客户端可优先读工具回执的 `structuredContent`，旧协议客户端可解析 `content` 中的 JSON 文本。

## 查找工具和对象

工具和对象已知时可直接调用。连接后的 `tools/list` 返回工具和输入 schema。`es_capabilities` 可查看 ES 操作目录，用 `{"query":"plot"}` 搜索工具名及说明，用 `{"action":"工具名"}` 查看一个工具的参数。用 `es_targets` 的 `kind`、`query`、`cursor` 和 `limit` 查找对象。回执已有实际对象或适用的 `next.tool` / `next.arguments` 时可直接接续。

若客户端连接后仍显示启动时的精简目录，使用同会话的 `es_call({"name":"es_capabilities","arguments":{"action":"es_import"}})` 读取绑定窗口的实际定义，再以 `es_call` 传入工具名和原生参数。窗口绑定、权限、返回值和失败原因沿用直接调用。

| 操作 | 常用入口 |
|---|---|
| 窗口、项目和文件 | `es_context`、`es_targets`、`es_tabs`、`es_show`、`es_project`、`es_import`、`source_attach`、`es_export`、`file_list`、`file_inspect`、`file_write_text` |
| 建模和选择 | `model_create`、`model_read`、`model_edit`、`model_select`、`model_constraints`、`model_measure`、`model_stereochemistry`、`model_geometry`、`model_bond_perception`、`model_transform`、`model_derivation`、`model_crystal_inspect`、`history_action` |
| 片段、结构库和二维 | `structure_source`、`model_fragment`、`model_library`、`model_personal_library`、`model_personal_fragment_place`、`sketch_open`、`sketch_read`、`sketch_edit`、`sketch_history`、`sketch_image`、`sketch_stereochemistry`、`sketch_to_3d` |
| 视图、轨迹和结果 | `view_style`、`view_camera`、`frames_select`、`frame_read`、`frame_measure`、`frame_extract`、`trajectory_view`、`trajectory_derive`、`trajectory_export`、`result_read` |
| 分析、绘图和图像 | `analysis_view`、`analysis_panel`、`analysis_configure`、`analysis_run`、`analysis_control`、`analysis_export`、`vibration_view`、`plot_open`、`plot_read`、`plot_point`、`plot_window`、`plot_edit`、`plot_configure`、`plot_preset`、`plot_export`、`view_export` |
| 输入和外部作业 | `input_draft`、`input_solvents`、`input_inherit`、`input_bind_endpoints`、`input_scan`、`input_assets`、`input_preview`、`input_generate`、`input_text`、`input_save`、`input_batch`、`job_preview`、`job_submit`、`job_read`、`job_open_snapshot`、`job_operation_plan`、`job_operation_execute` |
| ES 内部计算 | `es_opt_start`、`es_md_start`、`es_xtb2_generate`、`es_conformer_read`、`es_conformer_configure`、`es_conformer_run`、`es_pes_groups`、`es_pes_parameters`、`es_pes_configure`、`es_pes_run`、`es_pes_mode_read`、`es_ci_neb_batch`、`es_run_list`、`es_run_read`、`es_run_wait`、`es_run_control`、`es_run_frame_read` |
| 设置、环境与组合 | `settings_access`、`settings_show`、`compute_resources`、`job_environments`、`job_environment_check`、`job_environment_save`、`job_environment_transfer`、`job_site`、`job_library`、`multiwfn_configure`、`gxtb_configure`、`citation_export`、`batch_apply` |

### 文件路径和交付

- 用户指定的绝对文件路径始终优先。公开 `directory` 的入口也可指定绝对目录并沿原生文件名保存。纯导出操作省略目标时使用当前便携包的 `harness/exports/`。兼有预览或读回能力的 `plot_export`、`view_export` 与 `trajectory_export` 可传 `save:true` 使用随包目录。只看图像或读取内容时用原有预览或读回入口。保存回执提供实际文件路径。
- 文件名未知时，用 `file_list({directory,extension:"out"})` 查用户授权绝对目录的直属普通文件。回执的 `items[].path` 可直接传 `es_import`。多页时用 `nextCursor` 接续。只需读输出中的终止行或核实一份原件时，可对实际文件用 `file_inspect({path,tailBytes:8192})` 或 `file_inspect({path,sha256:true})`。
- 写临时文本可用 `file_write_text({fileName:"draft.xyz",text})` 放入包内 `harness/work/`，也可传用户指定的绝对 `destination`。用回执实际路径导入。目录不可写时，根据回执改用用户指定的其他位置。

- `es_project` 的 `open`、`recover` 或指定路径保存使用 Windows 绝对 `.es` 路径，例如 `C:/ES-work/demo.es`。`open` 可返回 `queued`、`loading` 或 `already-open` 等状态，以原回执标识的窗口为准。用同一 `path` 调 `es_project({action:"open-status",path})` 查看加载结果。失败或取消后需要再尝试时才使用 `retry:true`。
- 要核对当前项目的保存结果，先 `save`，再 `es_project({action:"reopen"})`。它从已保存的 `.es` 重读，在原窗口保留 Agent 连接。若存在未保存编辑，可以按用户意图明确传 `unsaved:"save"` 或 `"discard"`。`close` 会关闭绑定窗口。
- `es_project` 的 `action:"recover"` 默认查看恢复点，相当于 `recovery:"inspect"`。从回执的 `points` 核对保存时间和代次，再明确指定 `recovery:"auto"` 或 `"previous"`。收到 `opening_recovery` 后连接回执标识的窗口，通过 `es_context.project.recovered` 核对实际恢复结果。若回报 `project_already_open`，先用该窗口的关闭流程处理当前项目，再按已选恢复点打开。
- `es_import` 的 `items` 接受一个或多个绝对文件路径。成员可用字符串或 `{"path":"C:/ES-work/input.xyz"}`。单个结构可用 `mode:"structure"`。多帧 XYZ 或已有计算输出需要结果与轨迹时用 `mode:"analysis"`。导入默认跟随，`show:false` 仍可在后台导入。
- 要直接给坐标时，使用 `es_import({"mode":"structure","items":[{"format":"xyz","name":"helium.xyz","text":"1\nhelium\nHe 0 0 0\n"}]})`。要从结构数据库取得坐标，先按用途搜索或直接从已知记录 ID 调用 `structure_source`。导入回执记录实际来源和产物。
- `structure_source` 导入时可传绝对文件路径 `destination`，同时保存本次下载的原始字节。已存在的文件会保留。`importStatus` 是模型导入结果，`original` 单独报告原件保存状态、实际路径和 SHA-256。
- `source_attach` 的 `result` 接受原生 `ownerId`、模型结果引用、文件来源引用或 `es_targets({kind:"file-job"})` 返回的确切作业 `ref`，`asset` 是配套文件的绝对路径。需要替换已占用槽时明确传 `replace:true`。文件级槽的回执为 `scope:"scientific-file"`，并返回实际 `sourceId` 和原生验证的 `boundJobIds`。用作业引用时只有附件取得该作业的唯一科学对应才能提交。波函数配对使用文件当前选定的作业。IRC 配套使用原生识别的作业归属。若希望保留尚未取得作业对应的文件级附件，或替换整个主 OUT，用文件来源的 `ref`。接入本身保留当前显示和文件的选中作业。
- `file_write_text` 按传入内容写出 UTF-8，并报告实际路径和字节数。例如 `{"destination":"C:/ES-work/input.inp","text":"! HF STO-3G\n* xyzfile 0 1 water.xyz\n"}`。输入和引用的结构文件准备好后，可交 `job_preview` 核对，或用 `es_import` 打开支持的文件。
- `es_export` 用 `destination` 指定一个绝对文件路径。接受 `directory` 的工具会在指定的现有目录内按实际文件名保存。已有同名文件时默认回报冲突。用户决定替换时可传 `onExists:"overwrite"`。结构导出回执中的 `representation` 标明几何用途及省略键表。SDF、MOL 的键数为零，重开时的感知键不代表文件写入了连接。要继续编辑并保留 ES 模型键图，可用 `es_project` 保存项目。其他格式损失仍按 `losses` 回报，核对后可传 `allowLosses:true`。

### 实窗定位和冲突

`es_context` 返回当前项目、活动对象、模型修订、选区和可用帧。用上次回执的 `cursor` 作为 `since` 查询变化。通过 `targetRef` 按对象标识过滤，通过 `kinds` 按事件类型过滤。例如传 `{since, targetRef: modelRef, kinds: ["model", "input"], waitMs: 4000}` 等待该模型或其输入草稿的下一条匹配变化。过滤只作用于变更列表，返回的 `cursor` 仍覆盖本窗口全部事件。收到 `refresh:true` 时重新读取对象。用户手工编辑后，可用 `model_read`、`sketch_read`、`input_draft` 或 `plot_read` 取得对象内容和当前版本。

`es_show` 接收 `es_targets` 返回的对象 `ref` 或 `frames_select` 返回的 `frameRef`。定位模型时可同时指定模块，例如 `module:"input"`。帧索引在指定集合中从 0 开始，`sourceFrameIndex` 保留来源序号。使用原样返回的帧引用，来源关闭或替换后重新选取。

`es_show`、`es_opt_start`、`es_md_start`、`es_xtb2_generate`、`es_conformer_configure`、`es_conformer_run`、`es_pes_configure`、`es_pes_run` 和 `es_ci_neb_batch` 使用同一呈现参数。写入模型、更新输入草稿或生成输入时，`model_edit`、`input_draft` 和 `input_generate` 也可指定呈现方式。读取和查询进度时保持当前页面。

| `presentation` | 实际行为 |
|---|---|
| `follow`（默认） | 在绑定的 ES 窗口内定位实际输入、计算或结果页，保留 Windows 焦点。运行准备期间用户已切换页面时，延迟定位回报 `superseded`。 |
| `foreground` | 用户明确要置前时，请求恢复并带目标原生窗口到 Windows 前台，可用于分离模型视口。`es_show` 也兼容 `foreground:true`。 |
| `background` | 用户要求后台时使用，保留当前 ES 模块、标签和 Windows 焦点。`es_show` 核对目标并返回当前显示。配置变更仍同步到所属对象。支持后台启动的工具仍提交计算，可按 `runId` 读取。 |

分析与绘图工具按自己的 schema 管理原生面板，例如 `analysis_view` 传 `page` 会定位该分析页，`plot_window` 的 `show` 会恢复所属图窗。`job_open_snapshot` 用 `show:true` 请求选中接管后的结果。

`waitFor:"selected"` 等待目标帧成为当前帧，`waitFor:"scene"` 进一步等待原生视口收到场景。等待可能回报目标仍在准备。`trajectory_view` 可单独观察 `current.index`、`current.requestedIndex` 和 `current.sceneSubmitted`。用定位回执的 `targetId`、`collectionId` 和 `requestId` 查询原请求。若回报 `superseded`，按用户随后选择的视图重新读取。

修改时使用最近读取的版本。模型操作用 `expectedRevision`，按当前选区删除或冻结时带上 `selectionVersion`，输入编辑用 `expectedDraft`，二维编辑用 `draftId` 和 `expectedRevision`，绘图编辑用 `revision`。以原子序号选择时从 1 开始。跨操作引用原子时使用读取回执中的稳定 ID。目标切换、操作中的手势或较新的用户编辑可能阻止提交。遇到冲突时，重新读取同一对象并基于实际变化调整操作。`model_edit` 中的一组命令使用一次提交和一次撤销。已有结果的几何编辑默认派生可编辑模型。

### 标签、分离视口和工作台布局

用 `es_tabs({action:"list"})` 查看模型标签、构象与 PES 组、文件来源、分析面板和图窗，以及每项实际可用的 `actions`。关闭指定项时，把其 `ref` 放入 `plan-close` 的 `refs`。省略 `refs` 和 `ref` 会规划关闭当前可见的模型标签。先核对每项的 `affected`、`effects` 和拦截原因，再用 `close` 提交返回的 `planId`。计划要求确认且用户已同意时传 `confirmed:true`。

`close` 回报 `operationId` 后，用 `es_tabs({action:"status",operationId})` 等到 `phase:"finished"`，逐项读取实际结果。`cleanup-pending` 表示仍有资源待释放，可用同一 `operationId` 请求 `retry-release`。原生关闭流程保护运行中的对象及外部原始文件。任务库回收与文件清理使用各自的作业操作计划。

`reorder` 传当前可见模型标签的完整 `refs` 顺序。`layout` 的 `mode` 可为 `single`、`tiled` 或 `free`。`detach`、`dock`、`rename` 和 `group-collapse` 按列表中目标的可用动作执行。这些写入的 `expectedRevision` 取 `list` 的 `workspaceRevision`。分离和停靠后，可核对回执及列表中的实际归属。

`settings_access({area:"layout",action:"write",paneSizes:{leftWidth:35,rightWidth:320,previewHeight:260}})` 使用当前功能页原生分栏。左栏用百分比，右栏和输入预览用 CSS 像素。`actual` 是可见尺寸，`fields` 区分 `applied`（实际采用）、`fitted`（按原生空间约束匹配）、`stored`（已保存，控件当前不可见）和 `pending`（尚未确认）。

### 专用建模和输入操作

- `model_geometry` 接受按顺序排列的 2、3 或 4 个原子 ID 及目标值，分别编辑键长、键角和二面角。距离用 Å，角度用度。例如在 `sides` 中传 `{first:"fixed",last:"branch"}` 可固定第一侧、移动末端分支。`model_bond_perception` 在可编辑模型上使用原生经验成键或 GFN2 成键，可选重建或补充已有键。
- `model_stereochemistry` 读取原生碳立体中心 CIP 标注。指定 `modelRef` 读取工作结构，或传 `source:"frame"` 和 `model_read` 返回的 `frameKey` 读取当前已准备的结果帧。可根据 `assignments` 与 `status` 核对赋值。需要编辑时，`model_edit` 的 `invert-stereocenter` 反转指定立体中心。`model_crystal_inspect` 可查看对称性和可用的切面终止层，`model_transform` 可据此生成超胞、切面或有限团簇。
- `model_fragment` 可读取整模型或选中部分的片段，也可提取成新模型。把返回的 `fragment` 交给 `model_edit` 的 `place-copied-fragment` 命令即可放置或连接。用 `model_library` 的 `kind:"personal"` 读取个人库版本，用 `model_personal_library` 的 `expectedVersion` 提交写入。
- 图片打开到二维编辑器后，用 `sketch_image` 核对图片方向、裁剪和 MolVec 可用性。可用方向校正后的像素矩形更新裁剪，再请求识别。有待确认候选时，按当前草稿版本和 `candidateId` 接受或丢弃。
- `sketch_read` 的 `snapshot.documentKey` 对应写入参数 `draftId`，`snapshot.revision` 对应 `expectedRevision`。`sketch_edit` 提供 `smiles`、`ket` 或 `commands` 中的一项。局部编辑用 `sketch_read({includeGraph:true})` 查当前原子和键。例如传入 `smiles:"CCO"` 可以由原生编辑器布局到同一草稿，再使用最新回执里的 `revision` 进行二维原生撤销或生成三维。用 `sketch_stereochemistry` 查看 R/S 标注，`shown:true` 显示，`shown:false` 隐藏，`retry:true` 重试。
- `input_draft` 返回草稿版本、当前参数和可写的 `configuration`。写入传当前 `draftVersion` 作为 `expectedDraft`，以及包含 `engine` 和需要修改字段的补丁。可以从回读的 `configuration` 构造补丁。完整 `parameters` 用于读回原生状态。在具有已解析来源的模型输入页，可调用 `input_inherit` 继承计算级别并保留任务类型、冻结和资源选择。`input_preview` 查看原生预检，`input_generate` 生成到编辑器，`input_text` 修改实际正文，`input_save` 保存正文及配套文件。Gaussian 普通输入的 `files.writeCores` 和 `files.writeMemory` 控制资源指令。两者关闭且路线不生成固定资源头时，生成无需确认核数和内存。
- 要查对应引擎和模型的溶剂，用 `input_solvents({modelRef,solventModel:"smd",query:"water"})`，写入时取条目 `id` 与同一回执的 `draftVersion`。局部补丁用匹配的 `engine` 和 `settings:{solventModel:"smd",solvation:{mode:"builtin",id}}`。需要回气相时可直接使用回执的 `clearConfiguration`。未知条目或旧草稿溶剂无效时，按当前草稿版本及返回的恢复参数修复。只读 `input_draft` 保留当前页面，明确传 `presentation:"follow"` 时显示该输入页。
- `input_scan` 在 Scan 草稿中读取或替换扫描行。写入携带 `expectedDraft` 和按序排列的原子 ID。Gaussian 的一行可为 `{atomIds:[a,b], increments:10, increment:0.05}`，ORCA 的一行可为 `{atomIds:[a,b], values:[1.1,1.2,1.3]}`，或用 `start`、`end` 和总点数 `points`。更新扫描行时保留已有共享冻结。
- `input_assets` 管理 ORCA 的 HESS、GBW 或 MD 重启依赖。通过 `action:"import"` 和绝对 `path` 导入实际文件，`select:false` 可只导入，`replace:true` 可刷新同名同类依赖。已有依赖按 `assetId` 选择或编辑证据。HESS 和 GBW 可用 `reference` 记录同目录的原文件名。HESS 证据可用 `fromCurrent` 填入当前计算设置，显式确认时会核对实际文件、几何和来源。

构象精修后如阶段已返回 `representativeSelection`，可直接传给 `frames_select`，再加所需的能量排序及数量。需要临时查其他集合时用 `es_targets({kind:"collection"})`。批量按各成员状态读取已完成的产物与失败原因。

`es_opt_start` 省略 `method` 时使用工作台已应用的预优化方法。新建普通优化默认 L-BFGS／XYZ（`optimizer:"lbfgs"`），既有设置沿实际选项。显式传方法将同步到对应的分子或周期设置，手工按钮和空格键随后使用该方法。兼容的显式 `electronic:{charge,multiplicity}` 会同步到所属可编辑模型。从结果帧提交时，电子态随派生运行保存，原帧仍保留原始状态。用启动回执中的请求设置和 `es_run_read` 核对实际方法、原生后端和终态。

需要保留普通优化轨迹时，在 `es_opt_start` 指定 `retainTrajectory:true`。用实际运行 ID 查看有效终态，通过回执或 `es_targets({kind:"collection",query:runId})` 找到轨迹，再选择、裁剪或导出。已保留的构象运行在 `es_conformer_read.retainedCollections` 和 `es_run_read.collectionRef` 提供可直接传给 `frames_select` 的集合引用。

## 可组合的调用例子

示例中的 `call(name, args)` 表示调用工具并取成功回执。引用和版本变量来自该窗口的工具回执。各例可分别使用自己选出的帧。示例科学设置只用于说明各成员如何传参。

### 取帧、定位和导出

用运行回执的 `collectionRef` 直接选帧或定位播放器。初次查找可用集合的实际 `ref`。集合内 `indices` 从 0 开始，`frameNumber` 从 1 开始。播放器的 `current.playerFrameNumber` 记录界面位置。原样传递工具返回的短 `frameRef`。它可用于同一工作台的读取、显示、计算与导出。来源变化或另开项目后重选实际集合。只需要简表时使用 `detail:"summary"`。

```javascript
const { frames } = await call("frames_select", { collectionRef, indices: [2, 0], detail: "summary" });
const frameRefs = frames.map(frame => frame.frameRef);
await call("trajectory_export", { frameRefs, format: "extxyz", destination });
```

这段示例从至少三帧的集合按指定顺序导出。单帧可交 `es_export`，需显示用 `es_show({target:frameRef,waitFor:"scene"})`，确需独立编辑再用 `frame_extract`。用 `frame_read` 读几何、原子 ID 与晶胞。用 `frame_measure` 按序给 2、3 或 4 个原子 ID，周期测量可给镜像 `images`。测多个帧时，可传同一集合的 `collectionRef` 和 `range` 或 `indices`，也可传 `frameRefs`。需要极值时传 `detail:"summary"`，直接沿各项 `min.frameRef` 或 `max.frameRef` 读回。需要独立播放一组帧时用 `trajectory_derive`，保留所选顺序、原始序号及能量单位。新集合可沿回执的 `collectionRef` 或 `next` 接续。周期格式 `extxyz` 可保留晶胞。

对有振动分析页的文件结果，可用 `analysis_view` 打开 `page:"vibrations"`，再用 `vibration_view` 读取 `viewRef`、`revision` 和可用模式。更新时传入 `viewRef`、`expectedRevision` 和 `patch`，例如 `{mode:1, amplitudeAngstrom:0.2, playing:true}`。显示模式号从 1 开始，可信场景状态见 `scene.status`。振动操作作用于原生显示，原频率数据继续归属计算结果。

### 打开并导出原生图

外部扫描输出从确切作业用 `result_read({targetRef,part:"scan"})` 读 `completedPointCount`、`lastCompletedPoint` 和 `lastReadableFrame`。需要原生单轴坐标时加 `includeCoordinates:true`。用回执的 `next` 打开 `kind:"scan-energy"` 图。比较两份扫描图时，可用 `plot_open` 的 `axis:"source"` 选择真实扫描坐标，或用 `axis:"ordinal"` 按完成点编号。图已打开时，使用 `plot_configure` 的 `scope:"scan-axis",patch:{axis:"source"}`，也可设为 `ordinal`。需要坐标的图等实际横轴就绪再导出，用 `plot_export.scanAxis` 确认生效轴和单位。电子收敛曲线则以一个确切帧为来源。

对已有 SCF 数据的结果，可从 `es_targets` 取得结果或文件作业引用，从 `result_read` 的 `part:"frames"` 取得集合内帧号，再打开曲线。若回报 `opening`，待 `plot_read` 的列表出现该图后读取版本、修改和导出。

```javascript
const opened = await call("plot_open", {
  targetRef: resultRef, kind: "scf", frameIndex: scfFrameIndex,
});
if (opened.status === "shown") {
  const { plotId } = opened;
  const { revision } = await call("plot_read", { plotId });
  await call("plot_edit", { plotId, revision, operation: "text", role: "title", text: "SCF convergence" });
  await call("plot_export", { plotId, format: "svg", destination: "C:/ES-work/scf.svg" });
}
```

出图所需的编辑、模板、版式和实际支持的导出格式可从 `plot_read({plotId})` 取得。只需导出时用当前 `plotId`，无需先编辑。需要改画布和图种样式时按 `configuration` 选 `scope`，使用本图最新版本。原生图窗可用 `plot_window` 显示、最小化、关闭或调整布局。要保留可编辑图则保留图窗并保存项目。构象相对能量用相应阶段的 `plotTargetRef`。已有图源可从 `plot_read({})` 的 `availableSources` 中查找。

`analysis_view` 返回当前分析的原生页面、已接管的资产、可用图种以及支持的 `configuration` 和 `presentation`。根据对应 schema，按 `analysisId` 和 `sourceRevision` 用 `analysis_configure` 更新 `scope:"setup"` 或 `scope:"presentation"`。用 `analysis_panel` 激活、关闭、分离、停靠已存在的 `panelId`，或设定 `tabs`、`tiled`、`free` 布局。等待指定页面时可用 `analysis_view` 的 `waitMs`。

振动页可沿 `vibration_view` 返回的 `raman.apply` 指定激光波长（nm）和温度（K）。接续 `raman.plot.exports` 导出同源原生 Raman Stokes 图及数据。新建缩放副图时，`plot_configure` 的 `scope:"inset"` 先使用 `patch:{action:"create",range:{x:[xMin,xMax],y:[yMin,yMax]}}`。出现副图后再用最新图版本改位置或独立展宽。以 `plot_read.windowActions` 判断当前图支持的窗体操作。

用 `analysis_control` 读取运行状态，或带上当前 `sourceRevision` 请求停止，再核对是否实际结束。保存分析表或场时，用 `analysis_view` 或 `analysis_control` 的 `assets[].export.arguments` 直接调用 `analysis_export` 并加保存位置。原始 Molden 用 `result_read(part:"assets")` 的资产或面板的 `sourceAssets`。其配套 `assetRevision` 属于结果原件，面板自己的 `sourceRevision` 用于面板资产。Cube 导出保留与主文件校验值关联的有效域配套文件。符合原生准入的纯几何非周期有限簇可用 `analysis_view({targetRef:modelRef,page:"surface"})` 直接进入 Hirshfeld，用其 setup 指定 `targetIds` 并沿可用方法运行。面板已有相互作用散点或 Hirshfeld 指纹数据时，用 `plot_open` 的 `interaction-scatter` 或 `hirshfeld-fingerprint` 打开独立图。

`view_export` 采集已经就绪的实际视口，包含当前科学帧和所选显示选项。显示分离模型视口后同样可用其 `targetRef` 导出，回执记录实际来源和视口。可指定 `format:"png"` 或 `"svg"`、`transparent`、`includeAnnotations` 和尺寸。科学视口还可传归一化的 `crop:{x,y,width,height}`，以左上角为原点。顶层宽高为裁后输出像素。若画面还在准备，可沿回执定位并等待实际场景。

需要看图时，调用 `view_export({format:"png",preview:true})` 或 `plot_export({plotId,format:"png",preview:true})`。也可在同一次调用提供绝对 `destination`，或用 `save:true` 保存到随包目录。MCP 返回标准图像内容和科学来源回执，PNG 的 `imageSize` 报告实际尺寸。内置助手把图像作为视觉输入交给相应模型。查看器未就绪时遵循实际回执；读取文件名或尺寸只能确认导出结果，视觉判断需要模型实际收到图像。

模型相机按 `modelRef`、`expectedRevision` 和 `frameKey` 定向。已显示的结果或文件作业用 `view_camera({targetRef,action:"read"})`，写入用目标自身回传的 `cameraKey`。例如把结果 A 的原始视角 `view` 应用到结果 B，可切到 B 的实际场景后传 `{targetRef:resultB,action:"set",cameraKey:cameraB.cameraKey,view:cameraA.view}`。缩放用 `action:"zoom"` 和相对倍率，回执给出实际倍率与限位。

### 比较吸收谱和原始跃迁

只需原始跃迁表时，从 `result_read({targetRef,part:"transitions"})` 取得实际作业、阶段或帧的分组。多作业或多帧可加 `jobId`、`stageId` 和零基 `frameIndex` 定向。将选中组的 `asset.export.arguments` 交 `analysis_export`，并附 `save:true` 或保存路径，便可直接取得原态、源行、能量、振子强度和已打印跃迁贡献。

需要吸收谱时，沿实际跃迁组的 `openPlot` 接续，可直接定位同源光谱。也可在实际作业和帧的激发态面板取 `plots` 中 `kind:"uv-vis"` 的图。已有图也可沿其 `plot_export(format:"raw")` 保存原始跃迁。切换后旧图失活时，可从 `plot_read.reopen` 或回执的恢复动作按原作业、阶段和帧重新定位。比较图可分别统一坐标、范围、峰形、宽度及强度口径后导出 PNG。

### 保存主输入和配套

已绑定原生端点或 HESS 后，可用 `input_generate({modelRef,expectedDraft,directory})` 一次生成并保存完整快照。需要选某一主文件时传生成器内实际的 `fileName`，配套仍同组写出。明确指定 `destination` 时只保存一份文件。各成员结果在 `delivery`。保存失败但草稿已生成时，沿 `deliveryIssue.recovery` 或使用最新 `draftVersion` 补保存。生成输入无需提交作业。

### 批量准备 Gaussian 或 ORCA 输入

以已配置的模板草稿为例。用 `input_draft` 读取模板的 `draftVersion`。每项用不同的 `stem`，可指定自己的 `configuration`，也可用 `templateModelRef` 和 `templateDraft` 指向独立模板。对于未写明电荷和多重度的轨迹，按任务传入所确认的电子态，原帧保留来源字段。

```javascript
const template = await call("input_draft", { modelRef: templateModelRef });
const electronicState = { charge: 0, multiplicity: 1, confirmed: true };
const inputs = await call("input_batch", {
  modelRef: templateModelRef,
  expectedDraft: template.draftVersion,
  directory: "C:/ES-work/inputs",
  frames: [
    { frameRef: frameRefs[0], stem: "geom-02", electronicState },
    { frameRef: frameRefs[1], stem: "geom-00", electronicState },
  ],
});
```

两级构象精修后可从 `es_conformer_read({taskId}).collections` 取最后一级的 `representativeSelection`，直接传给 `frames_select` 并加 `order:"energy-ascending",limit:3`。示例的 `frameRefs` 可来自这次选帧。用 `inputs.items` 核对实际保存与部分失败。省略 `directory` 可以在回执中取得生成正文。准备好的输入可独立保存、修改或用于作业预检。

### 批量生成 XTB2 波函数

```javascript
const electronic = { charge: 0, multiplicity: 1 };
const wavefunctions = await call("es_xtb2_generate", {
  items: [
    { target: { frameRef: frameRefs[0] }, method: "gfn2", electronic, maxSccIterations: 80 },
    { target: { frameRef: frameRefs[1] }, method: "gfn2", electronic, maxSccIterations: 90 },
  ],
});
```

对已接收的成员，用各自的 `runId` 向 `es_run_read` 查询实际执行和结果接管。`es_run_diagnostics` 可读该次计算的诊断。

### 多对端点的 CI-NEB

下面假设每对端点的原子对应已经核实，可使用现有顺序。端点需要重排时，可传入以起点原子 ID 为键、终点原子 ID 为值的 `atomMapping`。

```javascript
const method = { method: "gfn2", solvationModel: "none" };
const electronic = { charge: 0, multiplicity: 1 };
const pair = (start, end) => ({
  start: { frameRef: start }, end: { frameRef: end },
  useAtomOrder: true, method, electronic,
});
const paths = await call("es_ci_neb_batch", {
  pairs: [pair(startA, endA), pair(startB, endB)],
});
```

用各成员的 `runId` 查看进展和科学终态。`es_run_read.ciNeb.climbingImage` 描述原生攀爬像及可用的下一步，`ciNeb.finalBand.plot` 指向最终路径图。没有内部势垒时可以交付实际路径，并报告攀爬像不可用的原因。需要单独设定路径任务时，先用 `es_pes_configure` 设置实际计算卡，从 `es_pes_groups` 查看组、卡及结果节点，再用组的 `groupId` 和卡的 `cardId` 调用 `es_pes_run`。

新建 SCAN 默认 L-BFGS／XYZ（`lbfgs-scan`），新建 CI-NEB 路径优化默认 L-BFGS（`parameters.nebOptimizer` 为 `lbfgs`）。已有任务的实际配置可继续沿用。配置 SCAN 时，用 `target` 从模型或结果建立 PES 组，或用 `groupId` 更新现有组。默认配置会定位到对应任务卡，并回报 `cardId` 和 `presentation`。`axisCoordinates` 显示各轴实际原子顺序和键角顶点。配置和提交可用同一 `nodeId` 指定扫描来源。省略时从提交时的实际显示帧起算。缺可用已就绪帧时按回执定位，再继续提交。运行保留实际坐标及帧来源。双端路径继续使用各自录制的端点。内置扫描的 `es_run_read.scan.readPoints` 返回同次运行的网格记录读取动作，含失败和缺失点。需最低能收敛结构时用其 `lowestConverged` 帧的实际选择参数。

当本组已有原子数不同的完成结果时，`es_pes_run` 返回 `CONFIRMATION_REQUIRED` 及 `data.retry`。收到用户明确同意后，用其中的参数和一次性 `confirmationId` 重提。返回的 `groupId`、`nodeId` 和 `runId` 属于本次新建的组与运行。未获同意时保留当前项目及快照。

### 读取和展示 PES 的确切路径帧

已有 `frameSelection.targetRef` 时直接用它。需比较不同相位或路径记录时用 `es_run_frame_read({runId,listRecords:true})`。需要实际帧号，则用 `es_run_frame_read({runId,recordId})` 读取该记录。

```javascript
const record = await call("es_run_frame_read", { runId, recordId });
const { targetRef } = record.frameSelection;
const { frames } = await call("frames_select", { targetRef, seriesId, frameIds: [frameId] });
```

这里的 `seriesId` 和 `frameId` 来自实际记录。需要图时沿记录回执的 `plot` 调用，也可用同一 `targetRef` 调 `plot_open({kind:"pes-path-energy",targetRef})`。工具使用该记录自身的能量。需要坐标时可读返回的 `frameRef`，也可在原 `es_run_frame_read` 加 `geometry:true`、`recordId`、`seriesId` 和 `frameId`。

### 配置和启动混合构象采样

以已确认电子态、未设置冻结或采样保护的非周期分子为例。`es_conformer_configure` 保存原生任务设置，`cards` 可组合 MD、元动力学和构象搜索。修改已有任务时先用 `es_conformer_read({taskId})` 读取 `revision` 和 `workflowRevision`。省略 `cards` 或 `stages` 会保留现有设置，传入列表则更新对应配置。

```javascript
const configured = await call("es_conformer_configure", {
  target: { modelRef },
  cards: [
    { kind: "md", method: "gfn2", integrator: "xtb", dtFs: 0.5,
      molecularTemperatureK: 300, molecularDurationFs: 100, molecularSampleEveryFs: 20 },
    { kind: "metadynamics", method: "gfn2", integrator: "xtb", dtFs: 0.5,
      temperatureK: 300, durationFs: 100, sampleEveryFs: 20,
      depositEveryFs: 20, heightEV: 0.01, sigmaAngstrom: 0.5 },
  ],
  deduplicationEnabled: true, dedupRmsdAngstrom: 0.01,
});
const sampling = await call("es_conformer_run", {
  taskId: configured.taskId, action: "sampling",
  expectedRevision: configured.revision, expectedWorkflowRevision: configured.workflowRevision,
});
```

`conformer-search` 卡可指定 `targetCount` 和 `torsions`。每个扭转用四个稳定原子 ID，并可选 `pointCount`。优化级可配置 `stages`，第一级用 `inputStride`，后续级用 `inputClusterCount`。支持原生优化的非周期 xTB 新级默认采用 `native-rf` 和普通收敛（`medium`），最多 500 步。也可显式指定该算法。原生 RF 使用宽松、普通或严格预设。新级使用自定义收敛且省略算法时沿用 L-BFGS。按原级 ID 更新并省略 `optimizer` 时保留该级原选择。用 `es_conformer_read` 的 `stages[].method.optimizer` 核对已保存设置。

运行后用 `es_run_read` 的 `mixedSampling.cards` 和 `mixedSampling.executions` 核对采样卡、执行段和引擎实际采用的设置，后者的 `effective` 在获得原生证据后出现。候选、去重、留存时长和已接管集合各有自己的回执字段。`es_conformer_run` 支持 `sampling-append`、`sampling-restart`、`sampling-reorganize` 以及单级或全部优化级的运行。

内部运行返回的 `runId` 可交给 `es_run_wait({runId,waitMs:5000})`。收到 `observation-timeout` 后沿原 ID 继续读或等待。结束观察只释放等待，不会停止运行。PES 回执中的 `hessian` 带实际 Hessian 所属帧、频率和来源，`irc.branches` 分别给出方向终态与末帧。用各方向的 `endpoint.frameSelection` 直接调 `frames_select`，可获得可用于导出或优化的短帧引用。

核实反应模态时，可沿 `es_run_read` 中 `hessian.readMode` 带所选 `mode`，或直接用 `es_pes_mode_read({runId,frameId,mode})`。传原 Hessian 帧号和从 1 开始的原生模态号。可用回执给带符号频率和按原子身份排列的 Å 几何与笛卡尔方向，方向的整体 L2 范数为 1。根据实际目标判断成断键、弯曲或扭转。IRC 可用 `es_pes_parameters({algorithm:"sella-irc"})` 查看原生参数。运行结果若已登记或回执不明，沿原窗口、组、任务或运行标识查询，再决定后续操作。

CI-NEB 可用 `es_pes_parameters({algorithm:"ci-neb"})` 查看原生参数和默认值。`es_ci_neb_batch` 每个成员用 `parameters.beads` 指定包括两端在内的总珠数，`nebIterations` 和 `recordInterval` 分别控制步数与记录。成员输入错误附原索引和原因，其余成员按实际条件独立执行。`acceptedRuns` 计已正式接收的运行，`observedNativeStarts` 仅计当时已有真实启动证据的运行。

## 查看运行和恢复

提交回执识别任务、运行、操作及有效设置。外部作业用 `job_read`、`job_diagnostics` 和 `job_operation_read` 核对，ES 内部计算用 `es_run_read` 和 `es_run_diagnostics` 核对。实际启动、科学终态、接管和显示以各自回执为准。已有可用结果时继续所需步骤。回执明确正在运行时，沿原 ID 等待。可向 `es_context` 传 `since`、`targetRef:runId`、`kinds:["run"]` 和 `waitMs`，等到内部运行状态变化后再续读。用 `batch_apply` 组合调用时，在各成员的 `result` 内核对工具回执和运行 ID。用批次 `id` 可读取当前窗口保留的批次回执。

### 全局设置和作业环境

- `settings_show({page:"tools"})` 打开当前窗口的「工具与文件」页，供用户检查 Multiwfn、g-xTB 和文件关联。页面打开后回报 `selected`。
- `job_environments` 返回执行环境和站点。用 `job_environment_check` 检查选定环境或候选配置，再用 `job_environment_save` 保存。修改已保存的环境时带其 `expectedRevision`。若原生检查发出主机指纹挑战，核对实际主机后，用 `job_trust_host_key` 提交回执的 `challengeId` 和精确 `fingerprint`。
- `job_environment_transfer` 可导出环境 JSON，或用 `preview-import` 核对绝对 `path` 或实际 `text` 后再 `import`。`job_site` 管理站点，`job_environment_delete` 删除环境配置时保留既有运行的冻结快照。用 `job_library` 查看和管理任务库，迁移和回收站清理按原生影响回执确认。
- `compute_resources` 查看实际资源偏好。写入时带读取的 `baseVersion` 和完整设置，可分别设置 Multiwfn 线程、xTB 单任务线程模式及线程数、xTB 批量并行数。Multiwfn 或 g-xTB 运行时按需用 `multiwfn_configure` 或 `gxtb_configure` 查看和配置。

### 外部作业提交、续读和接管

用 `job_preview` 预检原生编辑器里的实际输入，或通过 `input:{engine,path}` 传文件、通过 `input:{engine,name,text}` 传自写正文。为该作业指定 `environmentId`。需要额外结构或依赖时，可在 `dependencies` 中逐项提供 `path`，或 `name` 和 `text`。采用独立脚本的作业可传 `calculationScript`。确认 `ready` 后，用原计划 `planId` 调用 `job_submit`。

- 若提交回执遗失，同一会话可重用原 `planId` 取回提交结果。重连后用 `job_submission_lookup` 查询原预检回执中的 `submissionIntentId`。`unknown` 表示尚未取得注册回执，可继续按原身份核查。已结束任务需要重提时走 `job_resubmit_plan`，先查看覆盖范围，再按用户选择提交。
- 用 `job_list` 或 `es_targets({kind:"job"})` 找到实际任务，用 `job_read({taskId,refresh:true})` 更新监控状态。取科学帧第一页用 `job_read({taskId,frames:{offset:0}})`。后续把回执的 `frameCursor` 原样放入 `frames`，直到其为 `null`；收到 `JOB_SOURCE_CHANGED` 时从新集合第一页开始。
- 对已登记的文件用 `artifactId` 调用 `job_file_read`。传 `anchor:"tail"` 及 `maxBytes` 可读末尾。`job_file_find` 按 `query`、`fromByte` 和 `direction` 搜索，回报 `kind:"continue"` 时，把 `nextByte` 作为下一次 `fromByte`，并保留回执的 `searchEndByte`。`job_file_export` 把确切资产复制到新绝对路径。
- `job_open_snapshot` 将任务的受管结果接管到当前项目。接续已知运行时同时传 `taskId` 和原 `runId`。需要显示时传 `show:true`。后续用回执的 `documentId` 定位，核对 `sourceId` 确认来源。停止、归档、恢复、回收或删除作业用 `job_operation_plan` 核对影响，再用 `job_operation_execute` 提交。带 `operationId` 查询 `job_operation_read` 直到看见实际结算，必要时用 `job_operation_retry` 指定失败的任务。

## 在内置助手中工作

可在内置助手中直接描述对象和要求，例如“在后台量这一帧的键长”或“列出可关闭的模型标签，先给我看影响”。助手使用当前 ES 窗口里的同一套工具。每条工具记录可展开查看参数处理结果和实际回执。要控制呈现，可以在消息中明确说“在后台做”“在 ES 切到结果页”或“把结果窗口带到前台”。

可通过回形针、拖入或粘贴添加图片。发送消息或引导当前轮时，图片和文字会一起交给当前模型。需要用原生二维识别时，在附件上选择 **打开二维**，再在编辑器核对候选，或通过 `sketch_image` 查看和处理。

助手执行时，后续发送的消息进入队列。可对排队消息点 **引导** 让当前轮接收新说明，也可等待该消息按队列顺序处理。**停止助手** 暂停当前轮，**继续** 接续该轮并核对已发操作的回执。对已有消息点 **重发** 会送入新一轮。独立计算的进度和停止由其各自的任务控制处理。

## 开发入口

stdio 适配器处理客户端协议，桌面宿主维护窗口连接，工作台注册各功能的工具。宿主按实际请求核对来源和目标路径。 [stdio.cjs](../desktop/mcp/stdio.cjs) · [host.cjs](../desktop/mcp/host.cjs) · [use-workspace-tools.ts](../src/web/mcp/use-workspace-tools.ts) · [mcp-files.cjs](../desktop/mcp-files.cjs)
