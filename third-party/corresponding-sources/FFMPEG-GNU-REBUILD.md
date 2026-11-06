# FFmpeg GNU同功能重建及本地替换（供对应源码集成的草稿）

本稿只适用于Electron 44.7.0所用的FFmpeg fork提交
`2b68d2babae73714846961fb0ee47e3b3d2e39a9`及Chromium
`152.0.7977.130`的Chrome/win/x64配置。最终GNU DLL是独立本地构建，
不沿用官方签名或官方二进制hash。本次构建路径隐私修复版已通过原成对WAV/Opus
组件探针；此前SY便携ZIP图像与退出结果属于recipe的previousOutput，不能转记到
新DLL。新DLL的GUI复验由最终装配负责；全部codec矩阵没有执行。

## 必要输入

- 已提供的精确FFmpeg原归档、原LGPL2.1正文、原Electron
  `link_with_loader_path.patch`及`chromium/ffmpeg.sigs`。
- 同Chromium固定tag的`third_party/opus`完整源码和`tools/generate_stubs`。
  Opus README锁定上游`55513e81d8f606bd75d0ff773d2144e5f2a732f5`；
  Chromium archive裁掉的8个`.mk`需从该准确上游提交补齐。全部归档与小文本
  逐件URL/bytes/SHA应与本构建的获取索引一起提供，不能只给任意最新版主页。
- 已批准GCC13.2、MinGW-w64 11.0.1/UCRT/POSIX工具链、GNU make、CMake、
  Ninja、NASM及Git Bash。用显式过程级PATH，不要求普通终端用户安装它们。
- 从精确MinGW-w64 11.0.1源自行重建的Winpthreads静态库及原许可；本次R0库
  75,096B，SHA256 `6e41e0dae40ba035f5dd1aeb5043e520349444855cb150c3ffdcfeeeaa52c539`。
  此库来自独立R0源构建回执，不以工具链中另一个同名库冒充。

## 实际构建次序

1. 在新目录展开原FFmpeg和Opus，保原归档。应用原Electron patch；它只改变
   macOS install_name，Windows无运行含义，仍保留原补丁关系。
2. 以GCC/Ninja配置Opus Release静态库。固定`-O2 -DNDEBUG`和
   `CHROMIUM_NO_LOGGING`，关闭shared、programs、testing、DRED、OSCE、DEEP_PLC、
   fixed point和assertions，保hardening及原浮点/CPU调度。只构建，不安装到系统。
3. 由原Chrome配置中的配置命令取通用功能flags；仅把MSVC工具链部分改为
   `--target-os=mingw32 --arch=x86_64 --cc=gcc --ld=gcc --ar=ar --nm=nm`。
   显式Opus include/archive路径。原`--disable-everything --disable-all`之后仅
   启用avcodec/avformat/avutil和下列29项，不启用程序、network或新codec。
4. 比较生成的`config_components.h`**全部**宏与原Chrome/win/x64配置；包括所有
   原0项。只有完整相等才继续。平台HAVE宏单独记录，不把MSVC配置直接硬覆盖给GNU。
   本次一般CONFIG差异仅4个未使用D3D12头能力探针和文档POD页标志。
5. Git Bash产生的`/g/...`源路径需在生成的make入口和config.mak中规范化为
   Windows make可识别的`C:/work/...`或无歧义相对路径；固定Git sh。此步骤只改路径。
   路径中有空格时须按工具本身规则引用，不能把JSON转义当shell引用。
6. `mingw32-make -j4`只构建`libavcodec/libavcodec.a`、
   `libavformat/libavformat.a`、`libavutil/libavutil.a`。
7. 用原`generate_stubs.py -t windows_def -m ffmpeg.dll -i <out> -o <out>
   chromium/ffmpeg.sigs`生成原53项DEF。
8. `gcc -shared -static-libgcc -Wl,--exclude-all-symbols`，以该DEF、三个静态库、
   Opus静态库及上述R0 Winpthreads静态库组链接单个`ffmpeg.dll`。系统链接项严格
   取生成config.mak的EXTRALIBS、EXTRALIBS-avformat/avcodec/avutil；本次为
   `-lopus -lm -latomic -lole32 -luser32 -lbcrypt`。保ASLR/NX/高熵VA。
   Winpthreads先静态解析，不能无意多带一个`libwinpthread-1.dll`。

原启用集合：15个decoder为h264、aac、flac、mp3、vorbis、pcm_alaw、pcm_f32le、
pcm_mulaw、pcm_s16be、pcm_s16le、pcm_s24be、pcm_s24le、pcm_s32le、pcm_u8、libopus；
7个parser为aac、flac、h264、mpegaudio、opus、vorbis、vp9；7个demuxer为aac、flac、
matroska、mov、mp3、ogg、wav。encoder/muxer/protocol/filter等原值继续为0。

保存实际配置、完整编译/链接argv、修改记录、对象/静态库、DEF、导入库和最终DLL，
使用户能按相同方法重新链接自己的修改版。编译器/静态运行库的原声明、GCC Runtime
Library Exception、Opus和Winpthreads正文随实际代码保留；静态链接不消除这些条件。

## 独立本地替换及验收

把整个原Electron dist复制到一个新目录，仅在该副本替换`ffmpeg.dll`；记录新DLL的
实际bytes/SHA和源/补丁身份，不改原stock或旧交付目录。已有装配器通过明确
`--electron=<new-electron-copy>`和fresh `--out`读取该副本。官方ID校验继续用于原件；
本地修改版保持official/public=false，不伪装仍有官方二进制身份。

先核x64 PE、53项全部导出名及序号、实际依赖闭包。再在独立stock/new目录做成对
LoadLibrary/GetProcAddress和自生成PCM WAV/Opus解码；这验证必要API结构访问和
代表解码路径，不替代所有29组件或Electron/SY实际GUI验收。最后在自有实例核加载、
显示/导出、退出；不得因某项失败改用Chromium无proprietary-codec配置。

普通SY用户不需安装GCC、IDE或Python。可替换/重链接权限只在相应第三方LGPL所需
范围内适用，原SY自有禁售、对应源码及科研引用条件仍按其适用对象保留。


## 构建路径隐私修复

保持同一FFmpeg/Opus源、29项组件配置、53个动态导出及硬化检查。先将实际WORK、
GNU_ROOT和GNU_BIN路径规范为正斜杠，再把下列三类编译选项同时用于Opus CMake
CFLAGS和FFmpeg extra-cflags；实际完整argv以相邻recipe.json为准：

```text
-ffile-prefix-map=${WORK}=sy-ffmpeg-build
-fmacro-prefix-map=${WORK}=sy-ffmpeg-build
-fdebug-prefix-map=${WORK}=sy-ffmpeg-build
-ffile-prefix-map=${GNU_ROOT}=gnu-toolchain
-fmacro-prefix-map=${GNU_ROOT}=gnu-toolchain
-fdebug-prefix-map=${GNU_ROOT}=gnu-toolchain
```

这些映射递归覆盖源/构建目录。运行时__FILE__诊断仅显示可移植的源标签；不关闭
Opus hardening，不修改算法。对Windows路径先规范化，检查时同时扫描正反斜杠及
原始/两个UTF-16对齐视图。生成配置仍按原Chromium规则将FFMPEG_CONFIGURATION
置为NULL，实际本机编译记录留开发者私有目录。

最终DLL链接增加`-Wl,--strip-all`去除COFF本地符号/调试元数据；另保留一份未strip
链接结果供开发者私下调试。动态导出表、依赖和原53项API仍须逐件相同。静态库及
对应源码继续保留供重新链接，不能在二进制内搜索替换字符串来假造路径清理。

交付前针对最终DLL完整raw字节及两个UTF-16视图扫描本机构建路径，再运行原
stock/new成对WAV/Opus门。新的Electron输入必须从同版官方分发复制，除了
ffmpeg.dll以外的每个成员逐字节比较；原包及旧修改版保留。
