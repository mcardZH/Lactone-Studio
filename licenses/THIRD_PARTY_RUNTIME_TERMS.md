# 统一交付条件中的第三方运行库说明

本附件是当前候选正式随附的第三方运行库说明，以下必要LGPL例外适用于本候选。
公开下载的许可接受入口仍须在正式上线时落实；本附件不声称接收者已经接受，
也不表示公开发行已通过。不替代根`LICENSE.txt`、各组件原许可或实际交付流程。
不新增逐组件弹窗，不要求普通用户安装Visual Studio/Python/编译器。

## 统一入口可用文字

> 获取和使用SY-Studio时，请阅读根LICENSE.txt及licenses/README列明的实际第三方许可。必要Microsoft Visual C++ Runtime组件按随附微软Runtime原许可使用；在安装或使用这些组件前，您应阅读并同意该原文。若不接受，请勿安装或使用这些微软组件。开源组件继续享有其原许可授予的权利；SY自有许可不把这些组件重新许可为SY自有内容。

对需要明确记录的统一交付，可在同一入口使用一句：

> 我已阅读并同意SY-Studio根许可及本发行物实际适用的Microsoft VC Runtime接收条件，并知悉各开源组件按其原许可保留相应权利。

这里的微软原文是`runtime-distribution/microsoft-vc/MICROSOFT_VC_RUNTIME_LICENSE.rtf`，适用于当前实际随包的
必要app-local VC，**包括** NumPy 私有路径中的
`_internal/numpy.libs/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll`
（575056B，SHA256 `a4c2229bdc2a2a630acdc095b4d86008e5c3e3bc7773174354f3da4f5beb9cde`），
**不是**Community开发者许可。普通终端用户不承担Community
组织人数、IDE开发用途或订阅条件；再次分发微软组件的人需另具相应分发依据。
原微软许可中的法定和第三方开源许可例外、版权通知、无担保等条件完整保留。

MIT/BSD/PSF等组件主要落实原文要求的版权、条件、NOTICE和免责声明保留，
不因此制造逐项协议或额外安装流程。完整原文和准确来源集中在licenses，
仍按实际组件适用，不能由“已经集中存放”推定每个接收者已经同意。

NumPy该私有成员按微软条款适用，不由NumPy BSD或SY自有许可重新许可。
来源依据包括原wheel/RECORD、微软签名与VS2022 REDIST依据。精确14.40.33810微软carrier中的对应DLL及英文EULA已与本批材料逐字节比对一致，具体原包与成员身份见microsoft-vc/SOURCES及NOTICE；发行者资格证据单独留存。

## 必要LGPL第三方与对应源码构建控制例外

仅在相应实际组件许可证要求的范围内：用户可以取得其对应源码，修改、重建、
重链接或在独立本地副本中替换相应LGPL库；允许为自用修改和为调试这些修改
所必需的逆向工程。默认官方原件完整性核验保留；本地修改版以明确派生身份、
逐件修改和新输出回执进入，不冒官方验证或签名。

这些库及其独立修改版不额外承担SY自有禁售条款，也不仅因被本程序读取或调用
就必须引用SY。若实际修改/分发的对象包含SY作者自有内容，其自有禁售、对应
源码及科研引用条件继续按根许可适用；本例外不把整个SY产品统一改成LGPL，
也不授予对自有内容超出必要第三方兼容范围的权利。

对应源码控制材料的附加MIT授权，以同版本source-code内
`third-party/corresponding-sources/build-support/gnu-runtime/BUILD-CONTROLS-LICENSE.txt`
和`third-party/corresponding-sources/build-support/xtb-gnu/BUILD-CONTROLS-LICENSE.txt`为准。
前者仅覆盖该目录两个本地控制文件；后者仅覆盖其三个本地控制文件及明确声明的本地
build-only overlay变更。原上游部分仍用原许可，其他SY核心实现和资产不在此例外内。
这使相应控制及变更可随第三方对应源复制、修改和分发，不重新许可整个SY产品。
另有两项窄MIT许可：`scripts/release/replace-native-libraries-LICENSE.txt`仅适用于同目录独立替换helper；`third-party/corresponding-sources/privacy-source-derivatives/SANITIZER-LICENSE.txt`仅适用于其指明的净化控制脚本。其余上游源码仍按原许可适用。

对应源码入口为同版本`source-code/third-party/corresponding-source-index.json`
及`source-code/third-party/corresponding-sources/`；不是便携目录内隐藏的源码。
ASE Python修改版的具体步骤见`source-code/third-party/corresponding-sources/LOCAL-LIBRARY-REBUILD.md`。动态DLL、冻结模块
和静态链接分别落实替换/重链接，不以静态链接或仅附上游主页免除义务。

## 历史构建输入与当前接收条件

新候选不携带的Intel/SDK原库，其历史取材条款不作为当前运行库接收条件展示。
保留在开发者对应源码/原归档中的历史声明应明确其取材用途，不能改写成当前
portable仍依赖Intel。历史取材及发行者资格证据由发行者另行保存，不作为本附件中的接收者同意记录。
若新构建另需SDK/工具或出现新组件，其取得/接受及分发资格独立核对。

本选择对应GNU六个运行DLL、GNU xTB和GNU FFmpeg。完整GNU运行库及xTB源码/补丁/构建控制
已置于同版本 `source-code/third-party/corresponding-sources/`，入口分别为
`GNU-RUNTIME-SOURCE-INDEX.json`、`XTB-GNU-SOURCE-INDEX.json`及各自REBUILD指南。
FFmpeg实际53个导出名/序号、29个启用组件的对应验证及ASE现存Python源码修改后真实
导入/冻结/操作路径已有证据；这些事实不外推为任意ABI、任意算法或全部codec矩阵通过。
最终源码导出/程序包对应、交付入口接受记录和公开决定仍由Main分别冻结及确认；
本材料不代替接收者同意，不表示公开发行已批准。
