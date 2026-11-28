# 结构视图、科学图和导出

## 看结构、比较构型

- 需要看特定几何时，用 `es_show` 定位模型或帧，等 `waitFor:"scene"`。显示可用后，`view_style` 调整窗口外观。若需保存为个人预设，用 `action:"save-personal"`、名称和回读的偏好版本。启动默认设置另有原生入口。
- 相机可按晶轴或倒易轴定向，按实际操作用 `pan`、`rotate` 或 `zoom`。模型写入用 `modelRef`、模型修订和 `frameKey`。结果用 `view_camera({targetRef,action:"read"})` 查看当前结果相机。比较两份 ESP 时，可从第一份取得 `view`，切到第二份所需帧后，用第二份自己的 `cameraKey` 写入这个 `view`。
- 表面或轨道等值面沿实际分析对象调透明度、阈值、相位、色带与色尺。需要对比时，统一同一物理量的单位、显示范围和视角。原计算结果仍归原来的几何和数据源。

## 选对数据和图

| 用户要的结果 | 原生入口 |
| --- | --- |
| 指定帧的几何或画面 | 用集合选出的 `frameRef` 直接读或导出。看画面时用 `es_show({target:frameRef,waitFor:"scene"})`。 |
| 扫描能量、已完成点 | 用 `result_read({targetRef,part:"scan"})` 读同一作业的完成点。需图时沿 `next` 打开 `scan-energy`，要统一横轴时用 `axis:"source"` 取可用原生坐标，或用 `axis:"ordinal"` 按完成点编号。以回执实际横轴和单位为准。 |
| 电子迭代收敛 | 用确切作业和 `frameIndex` 调用 `plot_open` 的 `kind:"scf"`。 |
| 原始态和吸收谱 | 原始跃迁直接用 `result_read({targetRef,part:"transitions"})`，选择实际作业／帧组，沿该组 `asset.export` 保存。需同源吸收谱时可沿该组 `openPlot` 打开。已有激发态面板也可从其 `plots` 选择 `uv-vis`。 |
| CI-NEB 路径或构象能量 | 有路径 `plot` 回执时直接打开。构象相对能量沿实际粗优或精修阶段的图源。 |

只需导出时直接用实际 `plotId` 或回执提供的导出动作。切换作业后，若原图需要恢复，沿 `reopen` 或错误回执的同源动作接续。需要调整样式时，用 `plot_read` 一次看图版本、配置范围和可编辑项。比较两图时统一所需的轴单位、范围、峰形、宽度和强度口径。图需要继续编辑时，保留原图并保存项目。要定位峰或路径点时用 `plot_point`，图提供 `select` 时可回到实际关联对象。

## 预览与交付

- 要在主图内加放大副图，用 `plot_configure` 的 `scope:"inset"`，先给 `patch:{action:"create",range:{x:[xMin,xMax],y:[yMin,yMax]}}`。范围按小到大给，即使主图坐标轴反向。副图出现后再按新图版本调整框位置和独立展宽。

- 用 `view_export({format:"png",preview:true})` 查看已经就绪的三维视口。用 `plot_export({plotId,format:"png",preview:true})` 看实际图面。需要文件时同时给绝对 destination，或传 save:true 保存到便携包导出位置。PNG 的 `imageSize` 给出实际像素，用它和来源报告文件。用户要求统一图片大小时传支持的输出尺寸，图像视觉比较则用 `preview:true` 返回的真实图。
- 需要裁剪科学视口时，在 `view_export` 的 `crop` 中传 `{x,y,width,height}`。四项采用视口比例，起点在左上角，范围须位于视口内。顶层 `width`、`height` 是裁后输出像素。需要保留色标时把它纳入裁剪区域。
- 只需定量数据时可按 `plot_read` 的 formats 导出 TXT 或 raw。若用户要可编辑科学图，保存有原生图的项目。涉及指定帧的几何则用 `es_export` 或 `trajectory_export`，按需求保留晶胞和单位。
- 要解释已有结果或补分析场，见 [后处理](postprocessing.md)。查看计算进度以原运行和帧为准，预览用来判断实际显示。排查显示时可用 `view_export({scope:"workbench",preview:true})` 取当前已连接工作台。取可见的停靠分析面板用 `scope:"analysis-panel"`，附实际 `targetRef` 和 `panelId`。两者以原生 PNG 尺寸取图并保留当前界面。
