# 本地修改LGPL库、重建与替换

本目录相邻的`../corresponding-source-index.json`识别实际提供的准确源归档、
原recipe、补丁、许可和构建边界。第三方库按各自许可使用；修改这些库本身
不将其重新许可为SY自有禁售条款，也不取消原许可允许的修改、替换及必要调试。
SY自有内容的禁售、对应源码和科研引用条件继续按根LICENSE适用。

此处是开发者的本地修改流程，普通终端用户无需安装Python、编译器或Visual
Studio。以下过程不会自动下载工具、接受新许可或把本地修改版标为官方验收。
所有操作均在独立、无`.git`的导出源码副本内进行；原程序、原取材及旧输出保留。

## 1. 已有ASE Python源的受控派生

ASE3.28.0对应源归档已提供。现有冻结引擎使用其中选定模块，修改已存在的
ASE `.py`后需重新freeze；在旧程序旁放一个新`.py`文件不会自动替换PYZ内容。

先按源码根`BUILDING.md`从准确归档材料化输入。读取
`desktop/packaging/native-toolchain.lock.json`中的Python路径，后续均使用该
Python及其锁定PyInstaller；不在全局Conda/pip环境重新解析依赖。

在PowerShell进入该源码副本，准备仅含修改文件的overlay，例如：

```powershell
$localSourceRoot = (Get-Location).Path
$localRuntime = Get-Content -LiteralPath 'desktop/packaging/native-runtime.lock.json' -Encoding UTF8 | ConvertFrom-Json
$localToolchain = Get-Content -LiteralPath 'desktop/packaging/native-toolchain.lock.json' -Encoding UTF8 | ConvertFrom-Json
$localPython = Join-Path $localSourceRoot ($localToolchain.root + '/' + $localToolchain.python)
New-Item -ItemType Directory -Path '.local/overlays/ase-local01/ase' -ErrorAction Stop
Copy-Item -LiteralPath ($localRuntime.root + '/python/Lib/site-packages/ase/__init__.py') -Destination '.local/overlays/ase-local01/ase/__init__.py'
```

编辑overlay中的源文件后先查看计划：

```powershell
& $localPython -I -B scripts/release/derive-local-lgpl-runtime.py --source-root $localSourceRoot --overlay .local/overlays/ase-local01 --id local01
```

helper只允许覆盖已存在、原owner为ASE的`ase/*.py`，拒绝新模块、删除、二进制、
其他包、越界和links。计划列出逐件before/after SHA、完整副本大小和保持不变的
Library/bin DLL数量。当前Win11基线的155个DLL及所有非ASE成员、版本/能力不变。
这条窄入口不声称已支持任意依赖新增或ABI变更；扩展修改应先建立相应明确合同。

确认本地计划后生成独立输入：

```powershell
& $localPython -I -B scripts/release/derive-local-lgpl-runtime.py --source-root $localSourceRoot --overlay .local/overlays/ase-local01 --id local01 --write
```

新根为`.local/dependencies/win-x64/native-local-ase-local01/`，包含原锁原字节
`parent-runtime.lock.json`、完整新`inventory.json`、逐项`derivation.json`及
`derived-runtime.lock.json`。helper不修改活动锁、不导入ASE、不构建；输出必须
全新，失败后保留证据并选新ID。它复制完整输入副本，不修改父代原件。

在该独立源码副本中显式激活派生锁，再运行实际准备与freeze：

```powershell
Copy-Item -LiteralPath '.local/dependencies/win-x64/native-local-ase-local01/derived-runtime.lock.json' -Destination 'desktop/packaging/native-runtime.lock.json' -Force
& $localPython -I -B scripts/native/prepare.py prepare --run-id ase-local01
& $localPython -I -B scripts/release/build-native-local.py --run-id ase-local01 --preparation .local/dependencies/win-x64/native-local-ase-local01/preparation-ase-local01.json
```

新source pipeline会核认可父锁的完整bytes/SHA、原inventory、真实差集恰好等于
ASE overlay及155个DLL的完整身份，不靠给任意新ID放行。source/native/build
身份和其余完整性检查保留。准备会实际导入锁内模块，freeze会运行PyInstaller，
应由执行者安排资源和时限；本说明或数据helper的通过不等于这些步骤已执行。

freeze成功输出通常在`.cache/builds/local-source-ase-local01/native/engine/`。
把此**完整新引擎目录**作为现有`assemble-local.mjs --native=<新目录>`的输入，
其余dist、Electron、xTB和launcher保持对应版本及合法来源。必须装配到新的输出
目录，不能覆盖官方包；本地装配回执保持official/public=false并保留源修改记录。
不只拷一个engine.exe而遗失其`_internal/`或许可目录。

检验应包括：新Analysis闭包确实绑定修改后ASE源hash、该引擎真实使用ASE的代表
请求、原子/单位/状态及既有数值门、取消/退出。只改注释或加入本地标识可检验
来源通道，但不能代替真正改变库实现后的科学验证。未执行项目如实记未验。

## 2. 其他native LGPL DLL

tblite0.7.0、D44.2.0、D31.4.0及libiconv1.18的准确源、原Windows recipe及
patch已提供。先按各原recipe固定C/Fortran工具链、host依赖和DLL/模块ABI，
构建同版本修改库并记录源码/patch/配置及输出hash；不把xTB的另一个tblite
版本或不同Fortran ABI当这些库的对应重建。

上面的ASE helper刻意不放行DLL变化。修改native DLL需要其独立的准确输入
和重建/重链接合同，或在独立本地程序副本中验证ABI兼容替换；不得删掉全部
完整性校验、改用系统PATH兜底或宣称只要同文件名就兼容。若静态链接包含该
库，应提供实际许可证要求的重链接对象/源和脚本，不能以“已静态链接”省略义务。

## 3. FFmpeg共享库

现有Electron44.7.0使用固定Chromium FFmpeg fork，Release是Chrome branding、
`proprietary_codecs=true`、`is_component_ffmpeg=true`。本目录的独立
`build/args/ffmpeg.gn`是另一套无proprietary配置，不能拿它冒现有DLL的构建。

保留同codec/功能的ABI兼容修改版可在**新Electron副本**中替换`ffmpeg.dll`，
然后作为现有装配器的`--electron`输入。先比较x64机器类型、命名/序号导出、
导入依赖及实际codec能力，再核新副本启动、显示/导出、关键媒体/图像路径和退出。
PE导出一致只是必要条件，不能替代实际加载。若ABI改变，应重建与其匹配的宿主
并重新验证，不让现有宿主加载任意DLL。

修改版构建仍须完整、可取得的实际构建源/patch/配置与工具。本批GNU修改版已经
真实构建，53项导出及代表WAV/Opus对照通过，实际SY便携ZIP的图像与退出路径
已有核验；这不外推为全部codec矩阵。外部工具或新SDK条款按其自身
授权处理；普通用户运行程序不因此需要安装开发环境。
