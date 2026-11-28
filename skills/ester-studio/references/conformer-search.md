# 构象搜索和候选筛选

## 按体系选采样

- 联苯、短链烷烃等有明确柔性轴时，可以先用 conformer-search 卡，让 ES 发现扭转，也可给每个扭转的四个有序稳定原子 ID。
- 闭环或探索方式更灵活时，可用高温 MD，或在给定计算级别适用时用元动力学。温度随目标和体系选。常见 MD 起点为 50–200 ps、每 0.1–1 ps 取一帧，搭配成约 100–1000 帧。例如 100 ps 每 0.2 ps 约 500 帧。工具时间字段单位为 fs。
- 常规可考虑 GFN-FF。采样方法应与体系、电子态和目标相容。需要描述键变化时，可考虑 GFN1/2-xTB，并保留原采样几何和来源。

可组合多个原生卡。配置前可用 `es_conformer_read({discover:true})` 查当前模型，指定 `target:{modelRef}` 或 `target:{frameRef}` 可查其他已定位来源。用实际回执的可选卡、方法、积分器、自动柔性轴及未采用的原因决定下一步。权重和运行时按真实可用状态核对。已有任务用 `es_conformer_read` 回读实际的 `availableSamplingCards`、配置和版本。修改调用按当前 schema 带预期版本。只采样时可以按目的停在采样集合。

## 分级优化与接续

普通路线用 GFN-FF 粗优化，再取粗优阶段最多约 100 个低能代表做 GFN2-xTB 精修。支持原生优化的非周期 xTB 新级默认使用原生 RF（`native-rf`）、Normal（`convergencePreset:"medium"`）与最多 500 步。固定晶胞或需要自定义收敛阈值时，按该级支持的路线选择优化器。原生 RF 使用宽松、普通或严格预设。已有级别沿本身保存的算法和设置。归簇能窗、RMSD 和候选几何的优化收敛各自设置。

下面是已确认电子态的非周期分子示例，显式给两级优化。temperatureK 是此任务选定的采样温度。

    const task = await call("es_conformer_configure", {
      target:{modelRef},
      cards:[{kind:"md",method:"gfnff",integrator:"xtb",
        molecularTemperatureK:temperatureK,molecularDurationFs:100000,
        molecularSampleEveryFs:200}],
      stages:[
        {method:"gfnff"},
        {method:"gfn2",inputClusterCount:100}
      ]
    })
    await call("es_conformer_run", {
      taskId:task.taskId,action:"sampling",
      expectedRevision:task.revision,expectedWorkflowRevision:task.workflowRevision
    })

采样完成后，同一任务可用 `action:"all-stages"` 开始两级优化，也可运行指定级。第一级按 `inputStride` 抽帧，第二级从上一级按 `inputClusterCount` 取代表。已有有效候选时从相应阶段续行。

例如给正丁烷的三个低能精修代表生成 ORCA Opt 输入。从 `es_conformer_read({taskId})` 的 `collections` 取最后一级实际返回的 `representativeSelection`，原样传给 `frames_select`，附 `order:"energy-ascending",limit:3`。从选中的三个 `frameRef` 直接做 [批量输入](input-files.md)，无需逐帧切换工作台。同一代表也可用于 [XTB2 波函数](xtb2-wavefunction.md) 或结构导出。不同时间的采样帧可能处在同一构象盆地。用户需要不同构象时，优先用实际去重代表，或按结构性质区分已有帧。代表不足时，报告现有数量并按目标决定是否补采样。

优化级有候选结果但接管失败时，先按原 `runId` 用 `es_run_diagnostics` 查看 `adoptionRecovery`。原生批次仍可接管时沿返回的 `reload-results` 继续。已保存项目可复用已核实的候选时，先看 `projectContinuation` 列出的可复用与待重算数量，再按任务授权接续。
