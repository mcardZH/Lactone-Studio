# 势能面探索

## 有两端时从路径开始

分别优化反应物和产物，核对组成、电子态、级别和逐原子对应。已核实原子次序可用 useAtomOrder:true，需要显式映射时用 atomMapping。ES 内置新建 CI-NEB 默认 24 珠（含两端）、FSM 初猜、L-BFGS（`nebOptimizer:"lbfgs"`）与 Loose。已有草稿按实际参数。可用 `es_pes_parameters({algorithm:"ci-neb"})` 查当前值。需要逐个调整，先用 `es_pes_configure` 建路径卡，再用 `es_pes_run`。有多对已匹配端点时可用 `es_ci_neb_batch`。

看 `es_run_read.ciNeb.climbingImage` 的实际状态。已有攀爬像时可沿 `next` 取得其确切结构，用作 TS 初猜。若为 `unavailable`，可沿 `ciNeb.finalBand.plot` 交原生路径图，并报告返回的原因。端点和普通最高珠保留各自身份。需要 TS 初猜时，可另从真实内部候选或独立近峰结构接续。CI-NEB 未收敛但保有最后实际 CI 时，仍可沿带科学状态的帧作初猜。

## 仅有一端时沿几何坐标做松弛扫描

可选一或二轴。一个轴可由键长、键角、二面角或组合表达式定义。新建 SCAN 逐点松弛默认 L-BFGS／XYZ（`lbfgs-scan`），也可用 FIRE2／XYZ（`fire2-scan`）。适用分子体系也可用 Sella 并选 XYZ 或 RIC。轴上的内坐标定义扫描量，逐点优化使用的坐标系由算法参数设置。需要界面 Normal 档时，扫描卡传 `parameters:{convergencePreset:"medium"}`。

键角按「端点、顶点、端点」传稳定原子 ID。二面角的第二、第三原子构成中间键。提交扫描前，可从 `es_pes_configure` 回执的 `axisCoordinates` 核对实际原子顺序和键角顶点。

- 成键可把新键距离缩至略短于预计成键长度，例如新 O–H 从实际几何扫到 0.90 Å。
- 断键可按原键长的 2.5–3 倍估计拉伸范围，依体系看是否需要约 3–5 Å。
- 同时成断键可扫新键距离减旧键距离，例如终点先试 −1.6 Å。
- 两根新键同时形成，可先扫两距离之和，再读回每条实际距离。

以成断键组合轴为例，以下稳定原子 ID 取自本次源几何：

    es_pes_configure({
      operation:"scan",algorithm:"lbfgs-scan",target:{modelRef},
      axes:[{expression:"B1-B2",upper:-1.6,points:16,coordinates:[
        {id:"new-bond",name:"B1",type:"B",atomIds:[newA,newB]},
        {id:"old-bond",name:"B2",type:"B",atomIds:[oldA,oldB]}
      ]}]
    })

省略 lower 时，用提交运行时的实际起点。有明确来源节点时，配置和运行使用同一 `nodeId`。只指定组和卡时，从提交时实际显示的帧起算。若回执指出缺已就绪的目标帧，沿建议的定位动作准备该帧后接续。扫描峰顶附近的可用帧可接 TS。如果直接搜索走不通，可取峰两侧的局部极小帧，分别优化后作为 CI-NEB 端点。

扫描完成后，沿 `es_run_read.scan.readPoints` 可看实际格点记录，包括失败或缺失项。要取最低能收敛点就沿 `scan.lowestConverged.next`，保留该点的实测坐标和能量。

## TS、频率、IRC 与路径帧

新建 TS 默认原生 RS-P-RFO／XYZ（`prfo`），收敛档为 Normal。适用分子体系需要时可将同一算法的坐标系改为 RIC，固定晶胞用 XYZ。没有合适虚频时按原因调整，例如将 TS 每步最大原子位移设为 0.01 Å、适用时重算 Hessian，或收紧 CI-NEB 后重取初猜。从最终 `es_run_read` 的 `hessian.modes` 找候选虚频，将该模式号加到 `hessian.readMode.arguments` 后读取。也可传 `es_pes_mode_read({runId,frameId,mode})`，使用同一 Hessian 的帧和从 1 开始的模式号。根据各原子的原始位置与位移方向，可考察正负相位下关键键长、键角或二面角的变化。位移以整体归一化方向返回，位移幅度按用途取，正负相位等价。举例，预期扭转时看相关四原子的二面角是否响应。只找过渡态时，核对优化收敛，并确认频率结果仅有一个虚频且其成断键或构象变化对应目标反应，交付该 TS 帧和判定依据后即可收尾。目标包括验证连接时，再从该 TS 接双向 IRC。双向 IRC 连到预期两侧结构时，可作为最严格的连接证据。

内置 IRC 通过 `es_pes_parameters({algorithm:"sella-irc"})` 查步数和单位。新建任务每向默认 50 步，`stepMassAngstrom` 用 Å·√amu。ORCA 双向 IRC 的外部输入有自己的每侧上限，见 [输入文件](input-files.md)。

运行后用同一 `runId` 读取 `irc.branches`。按方向分别报告实际终态和末帧，将每个 `endpoint.frameSelection` 原样交 `frames_select`。达到步数上限时也可保留实际末帧作优化初猜，按该方向的终态报告结果。

### 端点后优化

按用户需要的参考态选择路线，两条路线使用对应端点的原始几何和原子身份。用 `frameRef` 定位同一帧，并保留原末帧作来源记录。额外构象比较时，再按目标另取结构。

- **反应物或产物复合物**。把整个末帧作为 `es_opt_start({target:{frameRef}})` 的初始结构，沿用各物种在该帧上的相对位置和取向，再整体弛豫。
- **反应物或产物无穷远**。从同一末帧用 `frame_extract` 取得模型，再用 `model_fragment` 的 `extract` 按原子 ID 提取各物种。提取时沿用原笛卡尔坐标与构象。各物种随后按各自电荷和多重度独立优化一次。需要无穷远参考能量时，按同一计算级别汇总各物种的能量。

IRC 未得到某一侧所需端点时，可用该 TS 同一帧的反应虚频方向，沿正负相位作适量位移后分别优化，或从实际 CI-NEB 两端、SCAN 两侧有效局部极小点附近的真实帧起步。按目标选用已有的合适来源，两侧可分别处理。交付时标明结构来自 IRC 末帧、虚频派生、CI-NEB 端点或扫描结构，并报告实际收敛和连接证据。需要沿 IRC 验证时，可按实际原因收紧 TS 优化或调整 IRC 步长再试。收到需要确认的操作回执时核对影响，用户同意后沿回执给出的精确参数续行。
