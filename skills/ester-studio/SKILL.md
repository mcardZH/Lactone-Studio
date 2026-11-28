---
name: ester-studio
description: 使用 Ester Studio 的工作台和 MCP 处理真实模型、计算帧和结果。适用于在 ES 建模、准备 Gaussian 或 ORCA 输入、优化结构、探索势能面、搜索构象、生成 XTB2 波函数、分析结果和出图。
---

# Ester Studio

用当前 ES 工作台的模型、结果或草稿完成用户要的操作。已有回执就从它接续，必要时也可用外部工具准备文件再交给 ES。

按下表选读相关章节。工具已知时直接调用。缺对象时用 `es_context` 或 `es_targets`，缺参数时用 `es_capabilities({action:toolName})`。外部 Agent 的连接和同会话工具发现见[工作台](references/workbench.md)。示例中的引用、路径和原子 ID 取本次回执。

从已明确的设置和来源出发。本轮目标满足后交付已有结果并结束。仍需接续时按本轮目标使用回执里的 `next` 或恢复动作，复用同一次运行、同一帧和同一草稿版本。导入、改草稿、生成输入、启动计算等有可见对象的操作，默认在绑定的 ES 工作台内跟随。跟随沿用 Windows 当前焦点。用户明确要求保持 ES 当前页面时用后台，明确要求带到 Windows 前台时才请求置前。只读结果、导出产物和切换画面按用户实际要的交付组合。

| 用户目标 | 按需阅读 |
| --- | --- |
| 连接、定位对象、选择帧、后台执行、保存或续读 | [工作台](references/workbench.md) |
| 打开结构、二维转三维、接枝、改键、选区或冻结 | [建模](references/modeling.md) |
| 编辑晶胞、扩胞、切面、建立缺陷或变换几何 | [高级建模](references/advanced-modeling.md) |
| 指定帧与视角、扫描和光谱、原始跃迁、图片与数据导出 | [可视化](references/visualization.md) |
| 从模型或选帧准备 Gaussian / ORCA 输入 | [输入文件](references/input-files.md) |
| 读取已有结果、配套波函数、计算分析量或导出数据 | [后处理](references/postprocessing.md) |
| 对当前模型或结果帧做普通预优化 | [普通优化](references/optimization.md) |
| 做扫描、CI-NEB、TS、Hessian 或 IRC | [势能面探索](references/potential-energy-surface.md) |
| 建立采样卡、优化分级、选低能代表构象 | [构象搜索](references/conformer-search.md) |
| 对一个或一组结构生成 XTB2 Molden | [XTB2 波函数](references/xtb2-wavefunction.md) |
