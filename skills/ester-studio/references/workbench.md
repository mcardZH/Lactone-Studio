# 工作台与接续

## 连接和定位

外部 Agent 从 ES 的「MCP 连接」页取配置提示词。用 `es_connect({})` 连接单窗。回报 `selection_required` 时从实际窗口列表选择。连接后刷新工具目录。若同会话仍只有初始工具，可从 `es_call({name:"es_capabilities",arguments:{action:"es_import"}})` 查参数，再用 `es_call({name:"es_import",arguments:{items:[absolutePath],mode:"structure"}})` 导入。正常发现工具后可直接调用。

不清楚当前对象时用 `es_context({})`，查特定来源用 `es_targets`，多作业结果用确切 `file-job`。已知操作但不熟悉参数时用 `es_capabilities({action:toolName})`。只熟悉目标时按名称或说明搜索 `es_capabilities({query:"plot"})`。

运行给 `collectionRef` 时可直接传给 `frames_select` 或 `trajectory_view`。集合内 `index` 从 0 开始，`frameNumber` 从 1 开始，`sourceFrameIndex` 记录原来源。播放器的 `current.playerFrameNumber` 是画布位置，需要科学帧时沿集合和实际帧引用。只需挑帧时用 `frames_select` 的 `detail:"summary"` 和所需数量。原样传回执的短 `frameRef` 给 `frame_read`、结构导出、[输入文件](input-files.md) 或 [XTB2 波函数](xtb2-wavefunction.md)。需要显示才用 `es_show({target:frameRef,waitFor:"scene"})`，需要独立编辑才提取为模型。想把一组选中帧开放为独立轨迹，可用 `trajectory_derive`，然后沿新集合的 `collectionRef`。项目切换或来源变化后，若帧引用失效就从实际集合重新选择。写入遇到版本冲突时，重读同一对象再提交局部修改。

用户给了目录但文件名未知时，用 `file_list({directory,extension:"out"})` 查授权目录内的文件，直接把返回的 `path` 交给导入。只需查文件尾或原件哈希时，用 `file_inspect` 读相关部分。

沿同一轨迹比较几何时，可把 `collectionRef`、帧范围和同一组原子测量一次交给 `frame_measure`。只需找代表帧时传 `detail:"summary"`，沿每项测量的 `min.frameRef` 或 `max.frameRef` 直接导出。若结果有多个可定位的来源，随集合带上实际 `targetRef`。

## 呈现和保存

- 执行可见操作时一般省略 `presentation`，沿原生 `follow` 在绑定的 ES 窗口打开相应输入、计算或结果页，保留 Windows 焦点。用户说工作台内跟看时也用 `follow`。明确要求保持 ES 当前页面时传 `background`，明确要求恢复窗口并置前时才传 `foreground`。分析和图窗按各自工具参数定位。文件导入还兼容 `show:false`，数据库搜索只读。
- 只读和等待沿原对象。等待到 selected 可确认帧选定，需要看到画面时进一步等 scene。异步运行后用户已切换页面时，定位可能回报 superseded，结果仍按原任务接管。
- 项目保存走 `es_project`。保存验证可在已有保存点上使用 action:"reopen"，有未保存编辑时按用户决定处理。关闭标签先用 `es_tabs` 的 plan-close 了解影响，再按计划操作。
- 用户指定保存位置时沿用绝对路径。纯导出可用工具适用的默认位置，支持 save:true 的预览或读回工具可用它写入便携包的 harness/exports/。临时文本可用 `file_write_text` 的 fileName 写入 harness/work/。以返回的实际路径验收。

## 运行和失败

内部任务保留 `runId`，按需用 `es_run_read`、`es_run_wait` 或 `es_run_diagnostics`。等待超时后沿原 ID 查询。停止观察和停止计算分别由助手和原任务控制。提交回执中断或批量部分成功时，先查同一项目、任务或批次中的已接收成员，明确未提交后再补。原生回执给出精确的恢复工具、输入字段或待确认影响时，优先沿该路接续。

需要查看 Multiwfn 或 g-xTB 时，用 `multiwfn_configure` 或 `gxtb_configure` 查询当前配置。资源从 `compute_resources` 读取，沿现有任务的实际限制执行。
