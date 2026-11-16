# Ester Studio 2.1.1 第三方许可与来源材料

本目录提供本版本的许可和署名材料。`publicDistributionApproved` 仍为 false；发布身份及对应源码须由最终候选复核。

- ES 自有部分沿该版本根 LICENSE。第三方各自沿原许可；ES 的许可不覆盖、限制或替代第三方权利。
- 原有 Electron/Chromium、FFmpeg、Ketcher/Indigo、图像解码、原生分析、SSH、OCR 等原文保留；旧来源材料仅在字节及组件相符时复用。
- `xtb-current/` 是当前 xTB 运行时原文；`xtb-source-licenses/` 是所附确切源码归档的许可。
- `pes-core/` 补齐 PES 核心 Python、Sella、JAX/JAXlib、ml-dtypes、NetworkX 等原文；`pes-libxtb-6.8.0/` 为新增常驻库及实际 GNU/OpenBLAS 组成原文。
- pyGSM MIT 原始署名为 Copyright (c) 2022 Cody Aldaz；Sella 的原文保留 NTESS 及 US Government 权利。论文作者和软件版权所有者分别保留。
- `fonts/DejaVu-LICENSE.txt` 独立覆盖界面嵌入的 DejaVu 字体，不能只依赖已排除的 matplotlib 副本携带许可。
- `structure-sources.json` 保留 301 个数据条目，对四个 NOMAD 条目补充署名。数据许可与科学引用按各自用途提供。
- 依据用户决定，下次公开包排除 AFIR/pysisyphus 的专属运行闭包；此目录不把该闭包声明为仍随包分发。
- g-xTB 改为用户从官方自行下载，ES 只配置并调用外部程序；本次公开附件不分发其二进制和专属闭包。此前“保留内置并取得源码”前置路线已被替代。保留的 GPL 文本仅为上游许可参考，不表示该程序仍随 ES 分发。

`SOURCE_INDEX.json` 对本目录逐成员给出字节数和 SHA-256，自身不列入。`SAME_BODY_INDEX.json` 只对确实原字节复制的许可材料声明原文未改。
配套源码准备见 `../third-party/corresponding-sources/pes/SOURCE-MATERIALS.json`；主 Agent 整合时可迁移为公共源码包的对应相对路径，并重新生成索引，不能把本 fork 的内部路径带入公开物。

源码、构建和替换材料见同版本配套附件 `Ester-Studio-v2.1.1-source-code.zip`。文中 `../third-party/` 与 `../scripts/` 路径相对于该源码附件，不表示它们已嵌入便携目录。
