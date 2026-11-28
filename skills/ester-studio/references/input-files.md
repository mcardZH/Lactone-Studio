# 从结构准备 Gaussian 或 ORCA 输入

## 从已有对象接续

从当前模型或实际帧取几何、原子顺序、电子态和已设约束。用户给了级别时照用。已有适用项目或解析来源可用 `input_inherit` 继续。未选方法时参考下文。

- 要生成一份，读 `input_draft` 的 `configuration` 与 `draftVersion`，按目标引擎写局部配置，带上一份回执的 `expectedDraft`。完成后用 `input_generate` 写到编辑器，要求保存时同时指定目的地。需要改正文时再用 `input_text`，想先看草稿能否生成时可用 `input_preview`。正常改草稿和生成会在绑定工作台内打开对应引擎的输入页，保留 Windows 焦点。
- 切换任务或方法时，可以在同一份 `configuration` 写明已决定的计算级别和数值设置。想采用新任务或方法的默认值时，省略相应选项。后续沿回执中的实际 `configuration` 生成。
- 要生成一组，读一次匹配引擎的模板草稿。将模板 `draftVersion` 作为 `expectedDraft`，为每个 `frameRef` 提供独立 `stem` 和已确认的 `electronicState`，一次调用 `input_batch`，`modelRef` 用模板回执的 `documentId`。每帧的 `electronicState` 包含 `charge`、`multiplicity` 和 `confirmed:true`。通用设置放在模板，逐帧差异才放入各项的 `configuration`，并注明对应 `engine`。
- ORCA CI-NEB 用 `input_bind_endpoints` 绑定两个真实端点。IRC 用 `input_assets` 配相同级别和几何的 HESS，其他作业也可按需绑定 GBW 等实际依赖。用 `input_generate({modelRef,expectedDraft,directory})` 一次保存该草稿的主输入和原生配套。只选择某一主输入时，可同时传其实际 `fileName`，仍随附原生依赖。指定 `save:true` 时使用默认导出目录，明确给 `destination` 时只写一份文件。由 `delivery` 核对各文件路径、相对引用和写入状态。若需要补保存，沿返回的 `draftVersion`，已有 `deliveryIssue.recovery` 时按该动作接续。生成器覆盖以外的方案可用完整原生文本通过 `file_write_text` 保存。

## 查溶剂和修改同一草稿

例如用户要求 Gaussian 的 SMD 水，用 `input_solvents({modelRef,engine:"gaussian",solventModel:"smd",query:"water"})` 查系统可用条目，再用查得的条目 ID 写 `configuration:{engine:"gaussian",settings:{solventModel:"smd",solvation:{mode:"builtin",id}}}`，`expectedDraft` 取该回执的 `draftVersion`。目标是气相时可用 `clearConfiguration` 在同一草稿清除溶剂。生成回报已有草稿的溶剂无效时，沿 `solventIssue` 提供的恢复入口重选或清除，保留原模型和其他设置。

## 常用任务的推荐起点

| 目的 | Gaussian | ORCA |
| --- | --- | --- |
| 快速预优化 | 明确使用 Gaussian 挂接时，GFN2-xTB 外部脚本、显式坐标、Opt=(Loose,NoMicro)，Gaussian 端单核。也可用 [ES 普通优化](optimization.md)。 | XTB2 Opt LooseOpt。 |
| 基态 Opt / Freq | B3LYP/def2SVP + GD3BJ。仅优化用 Opt=Loose。频率任务沿相应优化级别。适用 B3LYP/PBE0/CAM 结构任务可选 Int=(Fine,Acc2E=10)。 | B3LYP D3BJ def2-SVP def2/J RIJCOSX。仅优化用 Opt LooseOpt，Opt Freq 或独立 Freq 用 TightSCF，按方法选择解析或数值频率。 |
| 独立 SP | M062X/def2TZVP + GD3，SCF=Conver=6。 | wB97M-V def2-TZVP def2/J RIJCOSX StrongSCF DefGrid3。 |
| TS 和频率 | Opt=(TS,CalcFC,NoEigenTest) Freq。若有匹配 Hessian 可读 RCFC。挂 xTB2 的小体系可用 CalcAll，较大体系用 CalcFC 后补频率。 | OptTS，最终沿同一条件做 Freq 或 NumFreq。匹配的 HESS 可用 %geom InHess Read / InHessName。 |
| IRC | 建于实际合格 TS，沿同一势能面用 LQA，有兼容 Hessian 用 RCFC，否则用 CalcFC。建议 DFT 少于 50 原子时每侧 50 点，其他 DFT 30 点，挂 xTB2 每侧 100 点。 | 同一 TS 条件用 %irc Direction both，适用 HESS 用 InitHess Read / Hess_Filename。双向任务可按需求设每侧 `MaxIter` 20，当前新草稿默认 100。以草稿和实际生成文本为准。 |
| 垂直激发和 S1/T1 | 可从 B3LYP/def2SVP + GD3BJ 起步。常规 TD/TDA 优化求 5 根，S1 用 Root=1。T1 可用正确电子态的 UDFT 三重态。 | 同一层级配 def2/J RIJCOSX，普通 TDDFT 显式 TDA false。常规优化 NRoots 5，S1 用 IRoot 1，普通 T1 可用 UKS 三重态。 |

写 S1 草稿时，Gaussian 的激发态配置放在 `settings.taskOptions.excited`，ORCA 放在 `settings.excited`。字段依实际引擎草稿而定。

普通基态结构未指定频率且少于约 80 原子时可建议 Opt Freq，较大体系按所需性质选择。已有 Opt 级别的逐点 SP 或关联分析沿实际科学方案。要 Gibbs 自由能需实际频率。介质已知时可考虑普通 Opt/Freq 用 Gaussian IEFPCM 或 ORCA CPCM、最终 SP 用 SMD，路径和配套频率沿同一科学设置。

冻结或柔性扫描用实际原子次序。Gaussian 的 ModRedundant 从 1 开始编号，扫描采用增量次数和步长。ORCA 的 Constraints / Scan 从 0 开始编号，给范围和总点数或显式值。使用工具时按当前 schema 传稳定原子 ID。原生 ORCA CI-NEB 输入可从 XTB2、总 32 珠含端点、自由端点、IDPP + SIDPP、关闭端点预优化起步，检查主输入和 product.xyz 的原子映射。ES 内置 CI-NEB 与 IRC 的参数见 [势能面探索](potential-energy-surface.md)。

光谱态数按能区和体系规模选择，常用 20、30、50、80、100 根。NMR 可沿实际实验溶剂和匹配基组，Gaussian 有机体系 GIAO 可从 B3LYP/6-311+G(2d,p) + GD3BJ 与 SMD 起步。稳定性检查继承实际电子解，BSSE 沿被校正单点和实际分片。ORCA ESD 的前置任务可用与各态一致的 TightOpt NumFreq TightSCF DefGrid3，并准备匹配的 Hessian。高阶单点、分层、混合基组和 ECP 按实际科学方案准备。

核对最终正文中的坐标与电子态、方法、配套文件名、任务关键词和资源。Gaussian 的 %mem 是作业内存，ORCA 的 %maxcore 按每进程 MB 解释。Gaussian 普通输入若不写核数和内存指令，可直接生成，资源留给实际执行环境。生成输入后，如用户要求运行，可按回执中的文件和依赖继续作业预检。
