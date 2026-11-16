# PES LGPL 组件使用与替换

Sella、ASE、xTB/libxtb 及其相关 LGPL 组件沿各自原文许可。ES 对自有部分的限制不剥夺接收人依 LGPL 修改、替换这些库，或为调试该等修改而进行必要逆向工程的权利。项目已有 THIRD_PARTY_RUNTIME_TERMS.md 继续适用。

便携布局中的 `runtime/resources/pes/site-packages/` 含 Python 组件；Sella 2.6.0 完整源归档和 pyGSM 修改记录随配套材料提供。替换者须保留兼容的 Python/扩展 ABI；这项兼容要求不限制许可授予的修改权。

常驻库为 `runtime/resources/pes/libxtb/bin/libxtb.dll`，xTB 6.8.0 API 20000。替换需要兼容的 x86-64 C ABI，原始库 SHA-256 为 7ab0810d1e9a309493b07026e380934ebf116cc8924227bbe6874434d7b49b3e。替换启动校验不得成为禁止用户调试其合法修改的手段；正式包须具备可操作的替换/重新链接说明或机制，并对实际入口验证。

`../third-party/corresponding-sources/pes/libxtb-relink/` 提供已保存的重链接输入、原始锁和脚本。它们解决重链接材料部分，不能代替完整对应源码和最终候选的实际替换验收。附带 xTB/FIRE 的确切源码归档、源修改及构建参数；官方静态对象的全部传递源码和原始构建控制仍需按最终二进制核对。

兼容修改版采用配套源码中的 `scripts/release/derive-pes-library.mjs`：生成独立的库目录、派生 component/PES 锁和完整性清单，再沿本地重新装配路径使用。该工具不自动加载库或宣称科学验收。具体命令与阶段见配套源码 `BUILDING.md`。便携目录内的源码路径指同版本源码附件，不表示这些文件已嵌入便携目录。
