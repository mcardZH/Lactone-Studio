# 结构来源与分子建模

## 选好起点

- 已有结构文件，用 `es_import({items:[absolutePath],mode:"structure"})`。需要原结果或多帧 XYZ 轨迹时选 `analysis`，再从导入回执的实际集合选帧。只取结构几何时用 `structure`。简单体系也可在外部生成坐标，再用 `es_import({items:[{text:xyzText,format:"xyz",name:"molecule.xyz"}]})` 直接导入正文。需要同时保存结构文件时，用 `file_write_text` 写入，再把返回的路径交给导入。常规导入沿用 ES 原生判键，已有明确键图时可直接复用。
- 按名称寻找结构时，可查 ES 随包库，或用 `structure_source({action:"search",database:"pubchem",query:"caffeine"})` 查公开候选。已有确切 PubChem 条目可直接用 `structure_source({action:"import",database:"pubchem",recordId:"2519"})` 取三维 SDF，作为初始构象。COD 用晶体 CIF，按任务核对晶型和修订。RCSB 的配体用 `recordType:"ligand-ideal"` 取得理想坐标 SDF。若关心结合构象，取确切 PDB 条目中的对应配体。核对选中条目的化学身份和来源，沿回执中实际创建的对象接续。外部已下载的结构可直接导入。
- 要交付公共库的原始记录，同时在 `structure_source` 导入时传 `destination`。用 `createdIds` 接续模型，用 `original` 取得本次下载原件的实际路径和 SHA-256，保留原件中的键和其他字段。写入失败时按各自回执接续已有模型和文件。
- 只有二维图时，可导入 ChemDraw 文件、使用可用的图像识别，或在原生二维草稿中编辑后生成三维。按已有图稿的状态选整图导入或局部修改。
- 已有构象或轨迹，先选实际帧。从原帧做输入或计算时保留 `frameRef`，需继续添加或替换基团时用 `frame_extract` 取独立模型，也可按编辑工具支持的结果帧复制入口执行。

`es_export` 交付几何坐标。SDF、MOL 的键表为空，重新导入后 ES 可能按坐标判断成键。要保留 ES 模型的键和建模信息，可以保存 `.es`。需要带连接表交给外部程序时，已有公开或本地结构可沿用未修改的原件；几何已改变时，可将确切帧坐标和实际键级交给独立格式写出器，再回读所需的连接与立体信息。

## 二维绘制与三维生成

用 `sketch_open` 打开原生二维草稿。整图已确定时，可用 `sketch_edit` 写入 SMILES 或 KET。要在空白图上逐步绘制，或修改已有分子的一小部分，用 `sketch_read({includeGraph:true})` 读草稿和实际原子、键 ID，选择同一工具的 `commands` 入口。三个入口每次选其一。把 `snapshot.documentKey` 作为 `draftId`、`snapshot.revision` 作为 `expectedRevision`。

例如在空白草稿中画甲醇的 C–O 单键骨架：

    sketch_edit({
      draftId, expectedRevision,
      commands:[
        {type:"add-atom",element:"C",position:[0,0],key:"carbon"},
        {type:"add-atom",element:"O",position:[1,0],key:"oxygen"},
        {type:"add-bond",atomIds:["carbon","oxygen"],order:1}
      ]
    })

位置使用 KET 图纸坐标。批内可用刚创建原子的 `key` 接续，后续调用使用新回执的 `graph` 中实际 `atomId` 和 `revision`。已有键用 `set-bond-order` 改键阶，`remove-bond` 或 `remove-atom` 局部删除。一组命令对应一次原生撤销。手工或其他操作改过草稿后，先重读当前图。立体构型会影响下游任务时，用 `sketch_stereochemistry` 核对 R/S 和立体组。ABS 表示绝对构型，AND 表示混合物，OR 表示未知的单一成员。对查询结构等特殊对象，按原生回执使用适用的二维编辑入口。图稿确定后可用最新草稿版本调用 `sketch_to_3d`，沿返回的 `modelRef` 继续。

## 原生搭建与局部修改

`model_create` 新建工作模型，`model_library` 可查随包结构、内置三维基团或个人片段。`model_fragment` 可从已有模型取得片段，再用 `model_edit` 将片段独立放置或接到末端原子／端口。用同一模型修订提交一组编辑，方便整体撤销。遇到拥挤可先按需要 [预优化](optimization.md)，再继续搭建。

以搭建乙烷为例，可用 `model_library({kind:"element",element:"C"})` 查看原生预设与连接位。先在空白模型摆放 C 的默认四面体预设。`model_edit` 的 commands 为 [{type:"place-element",element:"C",position:[0,0,0]}]。用 `model_read` 取本次实际生成的 H。以该 H 的 ID 作为第二次 place-element 的 targetAtomId，并传该 H 的当前坐标作为 position。附着位置由原生接枝处理，末端 H 被替换，最终可读回 C–C 单键和六个 H。使用新回执中的原子 ID 继续改结构。若复用已有芳香母体生成衍生物，可在独立副本中对相应的末端 H 接入库中基团，保留原母体和不同衍生物身份。

局部漏键可用命令 {type:"set-bond-order",atomIds:[atomA,atomB],order:1} 补上。按原子 ID 选区，计算约束经 `model_constraints` 设置。`model_measure` 可测量或保存内坐标。以正丁烷为例，把四个连续碳的稳定 ID 按顺序传给 `model_geometry`，value:60，sides:{first:"branch",last:"branch"}，按实际连接让两侧分支协同转动。距离用 Å，角度用度。环内或跨连接的两侧可能重叠，按原生回执改用明确的移动范围。

周期结构、表面吸附构型及缺陷模型见 [高级建模](advanced-modeling.md)。
