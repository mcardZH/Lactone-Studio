# 从已有结果取得分析数据

## 先绑定实际来源

用 `es_import` 的 analysis 或 auto 打开主输出。多作业输出用 `result_read({targetRef,part:"jobs"})` 或 `es_targets({kind:"file-job"})` 找到实际作业。按用户目的读 summary、scientific、frames、structure 或 diagnostics，可直接取得已有的能量、收敛、热化学、频率和其他性质。

对于正常或中断的扫描输出，用 `result_read({targetRef,part:"scan",includeCoordinates:true})` 取得已完成扫描点及可测的原生扫描坐标。只需计数和能量时可省略坐标。报告各作业实际 `completedPointCount` 和 `lastCompletedPoint`，按需另报 `lastReadableFrame` 与最近的 SCF 状态。对中断作业，前缀的有效扫描点仍可出图和导出。

只有 Molden 或 FCHK 时，可直接以 `mode:"analysis"` 导入，再按它支持的分析继续。已有主输出，并需要配合 FCHK、Molden、ORCA HESS 或轨迹等文件时，使用相应原生槽。`source_attach` 的 result 可用原生 owner、文件源或确切 file-job，asset 用配套文件绝对路径。多作业配对须看实际阶段、几何和电子态以及 `boundJobIds`。Gaussian CHK 可先转成 FCHK，ORCA GBW 可先转成对应 Molden。ORCA 的振幅 JSON/CIS 按相应的原生激发态槽和支持项接入。需要广泛读数据时，从 `result_read` 的真实单位、性质和帧出发。

## 选择需要补的分析

`analysis_view` 打开确切 `targetRef` 的原生页，返回 `analysisId`、`sourceRevision`、可用方法、面板和资产。按面板实际支持设置 `analysis_configure` 的 setup，再用同一来源版本的 `analysis_run` 启动对应方法。用 `analysis_control` 观察真实状态。若回执给出 surface-restore-session，可按其入口恢复缓存表面的原生会话。

| 想获得的信息 | 路线 |
| --- | --- |
| 能级、占据、轨道形状 | orbitals 先读轨道及自旋，再按实际 `orbitalKey` 和面板提供的运行方法生成相应轨道格点。 |
| ESP、ALIE 或表面极值 | surface 用 electronic 系列。按设定的密度等值面、格距和物理量分析，区分表面统计与可视化网格。 |
| IRI、RDG、IGM 或 IGMH | interaction 用原生允许的方法。例如只需指定两片段的 IGMH，可在确切波函数源上设置片段并运行，沿同次结果选择所需格点、等值面或散点图。用户要看实际表面时再截取场景。 |
| 原子电荷、键级、NTO、反应性 | 分别查看 charges、bonds、excited、reactivity 的实际可用方法。NTO 或空穴–电子分析沿指定态的配套数据。 |
| 振动模式 | 有计算模态时用 vibrations 与 `vibration_view`，路径任务的频率可从原 Hessian 运行读取。 |
| Raman Stokes | 在指定源的 vibrations 面板用 `vibration_view` 读实际模式和修订。沿 `raman.apply` 提交激光波长和温度，再用 `raman.plot.exports` 保存原生图和数据。 |

例如为同一 Gaussian 作业补 FCHK 后，打开 `analysis_view({targetRef,page:"orbitals"})`，用回执实际轨道键选定占据或虚轨道。若任务接受 XTB2 波函数，也可从正确构型 [生成 Molden](xtb2-wavefunction.md)。

## 晶体邻域的 Hirshfeld 表面

准备包含目标分子与实际邻近环境的非周期有限簇，可由 ES 或外部工具生成。对符合原生准入的纯几何有限簇，用 `analysis_view({targetRef:modelRef,page:"surface"})` 直接打开 Hirshfeld。只有已有结果的面板当前是电子表面时，才用 `analysis_configure` 的 setup 补丁 `{family:"hirshfeld"}` 切换并沿新面板的回执继续。用当前簇中的实际原子 ID 指定 `targetIds`，其余原子作为环境。调用可用的 hirshfeld-surface 方法取得表面。开放预览用于看当前范围内的接触，完整闭合表面用于报告总面积及接触占比。按面板提供的图源打开 Hirshfeld 指纹图。需要分项时，先在 `analysis_configure` 的 `scope:"presentation"` 设置方向合并 `merged`，再从 `contactOptions` 选择 `selectedContactKey`。可用 `areaView:"table"`、`"chart"` 或 `"both"` 查看接触面积及贡献，按实际图 ID 导出。接触表 TXT 使用资产 `hirshfeld-contacts-table`，结构化接触明细使用 `hirshfeld-contacts`。

## 交付与接续

电荷表、表面数据等用 `analysis_view` 或 `analysis_control` 返回的 `assets[].export.arguments`。原始 Molden 用 `result_read(part:"assets")` 或面板的 `sourceAssets`。原始跃迁表用 `result_read(part:"transitions")` 返回的确切组。把对应的导出参数直接交 `analysis_export`，再加保存位置。面板的 `sourceRevision` 与结果原件的 `assetRevision` 各属于其资产。Cube 如有有效域配套一并保留。图与图面数据按 [可视化](visualization.md) 导出。需要 TXT 而原生资产未提供时，可从结构化回执整理列名、单位及来源。需要结构时沿 `frameRef` 读取、导出，或在需要独立编辑时提取为模型。
