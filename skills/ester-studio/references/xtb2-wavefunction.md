# 对模型或帧生成 XTB2 波函数

要对指定构象或轨迹帧做 GFN2-xTB 单点时，通常可直接用 `es_xtb2_generate({method:"gfn2",target:{frameRef}})`。画布显示其他帧时，仍以明确传入的帧为计算来源。已有同几何、电子态和级别的可用波函数时，可直接[做分析](postprocessing.md)。

也可对当前结构调用 `es_xtb2_generate({method:"gfn2"})`，指定模型用 `target:{modelRef}`。批量用 `items`，每项设置实际来源与级别。要求 XTB2 时显式写 `method:"gfn2"`，省略时沿用工作台的方法设置，可能是 g-xTB。电子态和溶剂按真实来源或用户设定。

按 `runId` 查看本次科学终态和接管。用户要电荷、轨道或 ESP 时，沿接管回执 `wavefunction.next` 定位准确的后处理目标，再在该目标打开相应原生分析页。

产生 Molden 但接管失败时，先查原 `runId` 和原生恢复入口，能复用时从同一产物接续。需要原始 Molden 时，用 `result_read({targetRef,part:"assets"})` 查询指定几何绑定的原始文件，或读 `analysis_view.sourceAssets`。用原件的 `export.arguments` 传给 `analysis_export`，再加绝对保存路径或 `save:true`。电荷表等面板资产各自带导出参数，沿该项回执保存。Cube 是由特定分析得到的场文件，按其自身单位和来源交付。批量任务逐项确认实际生成及接管，返回成功的文件或对象与需要续处理的成员。
