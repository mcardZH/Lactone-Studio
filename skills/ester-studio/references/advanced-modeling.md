# 高级建模

## 从晶体到实际表面或缺陷

从已有 CIF、随包库或外部工具的结构开始。需要建空位或替位时，先按所需浓度和周期尺寸扩胞，再在派生模型用 `model_read` 定位实际复制位置及原子 ID，通过 `model_edit` 删除或替换。在保留晶胞的周期格式中交付，构型另作独立模型。外部已完成扩胞、切面或缺陷构造时，导入实际产物后可直接接摆放、约束、优化和导出。

以从 Cu 体相取 (111) 表面为例，先确认晶胞和轴向。若终止层会影响化学组成或比较，对实际源调用 `model_crystal_inspect({modelRef,operation:"slab-terminations",parameters:{miller:[1,1,1]}})`。选定合适终止层后，在实际源视口调用原生切面。已确定参数时可直接应用，需要对照时先预览：

    model_transform({
      modelRef, expectedRevision, action:"preview",
      transform:{type:"crystal",operation:"slab",
        parameters:{miller:[1,1,1],thicknessMode:"angstrom",
          thickness:10,repeat:[2,2],vacuum:15}}
    })

厚度和真空只是初始模型示例。按预览回执的 `product` 和 `crystal` 检查层数、实际厚度、终止元素和晶胞。选定后带源模型的 `expectedRevision` 与同一个 `previewRef` 调用 `model_transform` 的 `action:"apply"`。源或帧变化后重新预览。需要指定层位时传选中的 termination，连续区间按当前原生参数用 start 和保留厚度。repeat 是面内重复数。vacuum 给两侧总厚度，position 是下侧真空，省略时通常居中。沿回执实际 `modelRef` 继续，为比较几个 CO 吸附初始位点，可保留相同表面并分别摆放 CO，按任务冻结深层原子。

## 晶胞和变换的归属

普通模型 assign-cell 或 edit-cell 通常原位生效。分轴调整用 cartesian 保留位置、stretch 沿该轴拉伸。转原胞／常规胞、P1、理想化、扩胞、切面及多数几何变换会派生模型。可用原生工具回卷、改轴序、整理跨胞片段，或使用 finite-cluster 选择是否保留晶胞。把派生结果交给后续操作时读回实际晶胞、周期轴和原子 ID。涉及原子对应时，可在变换时选择 `includeAtomMapping:true`，也可用 `model_derivation` 按 `sourceAtomIds` 查询派生关系。

只读晶体检查可对指定普通模型执行。`model_transform` 的派生操作使用活动源视口，其他源先用 `es_show` 定位。普通模型的原位晶胞编辑可选择 `presentation:"background"` 保留当前页。需要平移、旋转、镜像、裁剪或对齐时选 `model_transform`，也可在现有模型用 `model_edit` 对指定原子组做原位几何编辑。旋转中心、旋转轴或镜面可分别使用原子的稳定 ID（`pivotAtomId`、`axisAtomIds`、`planeAtomIds`）。有实际坐标参考时也可以直接传数值向量。只改变观看方向用 [视角工具](visualization.md)。需要比较表面位置或朝向时再看原生预览或实际视口图。
