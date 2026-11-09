# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：阶段二微分支 2C —— MolVec 离线化学结构 OCR 运行时轻量化与 macOS 跨平台适配
- **关联分支**：`mac/phase2c-molvec-ocr`
- **目标概要**：根据用户确认的轻量化方案，移除 `desktop/ocr-runtime.cjs` 与 `desktop/ocr/molvec-component.json` 对 JRE 文件树的哈希白名单校验及 316 项旧 JRE 哈希表，解除对 `win32-x64`（`bin/java.exe`）的单平台限制，支持 macOS（`darwin-arm64` 与 `darwin-x64`）的两种标准 JRE 路径格式（`runtime/<jre>/bin/java` 与 `runtime/<jre>/Contents/Home/bin/java`）及跨平台 `JAVA_HOME` 推导。

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. **移除 JRE 哈希白名单与旧哈希表，并支持跨平台架构 (`desktop/ocr-runtime.cjs`、`desktop/ocr/molvec-component.json`)**：
     - 将 `desktop/ocr/molvec-component.json` 精简为仅包含 `{ schema: 1, engine: "molvec", version: "0.9.8", jar: "molvec-0.9.8-jar-with-dependencies.jar" }` 的轻量元数据，彻底删除原有的 316 项 Windows JRE `files` 哈希表与 `sources`。
     - 直接去掉对 JRE 文件列表（`files`）的 SHA-256 哈希比对与全目录文件枚举拦截，不再要求磁盘 `component.json` 与宿主固定 JRE 哈希表逐项完全一致（无需考虑本地替换 JRE 木马威胁模型）。
     - 支持 `win32-x64`、`darwin-arm64` 与 `darwin-x64` 三个目标平台/架构；不支持的系统（如 `linux`）抛出 `OCR_UNSUPPORTED: 组件不支持当前系统。`，不支持的处理器架构（如 `win32-arm64`、`darwin-ia32`）抛出 `OCR_UNSUPPORTED: 组件不支持当前处理器架构。`。
     - 当组件目录尚未安装（`ENOENT`）时，在 `win32-x64`、`darwin-arm64`、`darwin-x64` 上 `capabilities()` 均返回 `status: "not-installed"`。
     - `resolve(engine, root)` 仅校验：
       - 组件根目录与父级目录非符号链接（`safeDirectory`）；
       - `component.json` 基本元数据合法（`schema === 1`、`engine === "molvec"`、`version === "0.9.8"`、`platform` 与字符串类型的 `architecture` 匹配当前运行平台/架构、`jar === "molvec-0.9.8-jar-with-dependencies.jar"`）；
       - `actual.executable` 匹配当前平台的受支持启动器相对路径（Windows 为 `runtime/<jre>/bin/java.exe`，macOS 为 `runtime/<jre>/bin/java` 或 `runtime/<jre>/Contents/Home/bin/java`，拒绝绝对路径并抛出 `OCR_COMPONENT_EXECUTABLE`）；
       - 磁盘上的 `executable` 与 `jar` 为非空普通文件（非符号链接），在非 Windows 平台上 `executable` 具备可执行权限位（`(mode & 0o111) !== 0`），且不读取 `executable` 内容以兼容 `0o111` 仅执行权限启动器；
       - 返回的 `componentSHA256` 与 `jarSHA256` 均采用磁盘上 `jar` 文件的实际 SHA-256，从而准确标识 OCR 模型 JAR，不受 JRE 文件或 `component.json` 附加字段变化影响。
  2. **跨平台 Java 启动器路径校验、`JAVA_HOME` 推导与命令构造 (`desktop/ocr/molvec.cjs`)**：
     - 保持轻量化实现（不内置任何 JRE 文件哈希表），导出 `DARWIN_ARCHITECTURES`、`DARWIN_EXECUTABLE_PATTERN`、`WIN32_EXECUTABLE_PATTERN`、`isSupportedJavaExecutable`、`resolveJavaHome`、`command` 与 `parse`。
     - 支持含空格与中文等非 ASCII 字符的 `<jre>` 目录名；`isSupportedJavaExecutable` 支持 `{ allowAbsolute: false }` 以在解析 `component.json` 时严格要求相对路径，对已解析的 macOS POSIX 绝对路径（以 `/` 开头）按 `path.posix` 语义处理（兼容含反斜杠合法字符的 macOS 目录名），并正确推导 `JAVA_HOME`（扁平 JRE 下为 `<root>/runtime/<jre>`，macOS Bundle JRE 下为 `<root>/runtime/<jre>/Contents/Home`）。
- **边界与非目标 (Out of Scope)**：
  - **不做 JRE 文件哈希校验与防篡改木马校验**：用户已明确指示去掉 JRE 哈希校验，不需要考虑本地挂木马的问题。
  - **不打包/不内置 macOS JRE 二进制文件到源码仓库**。
  - **不修改 `desktop/ocr-host.cjs`**：`ocr-host.cjs` 已通过 `platform === 'win32'` 条件守卫 PowerShell 监控脚本 `watch-process.ps1`，在 macOS 下无需修改。

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - `desktop/ocr/molvec-component.json`
  - `desktop/ocr/molvec.cjs`
  - `desktop/ocr-runtime.cjs`
  - `tests/desktop/ocr-runtime.test.mjs`（单元测试）
- **跨平台适配考量（macOS / Windows / Linux）**：
  - `win32-x64`：校验 `runtime/<jre>/bin/java.exe` 与 `molvec-0.9.8-jar-with-dependencies.jar` 存在性，按 `path.win32` 推导 `JAVA_HOME`。
  - `darwin-arm64` / `darwin-x64`：校验 `runtime/<jre>/bin/java` 或 `runtime/<jre>/Contents/Home/bin/java`（含 `0o111` 可执行权限位）与 `molvec-0.9.8-jar-with-dependencies.jar` 存在性，按 `path.posix` 推导 `JAVA_HOME`。
- **关键实现逻辑与架构影响**：
  - `desktop/ocr/molvec-component.json` 精简为 6 行基础元数据（移除 316 项旧 JRE 哈希表）。
  - `desktop/ocr/molvec.cjs` 精简为纯路径校验与命令生成逻辑（约 90 行）。
  - `desktop/ocr-runtime.cjs` 精简为跨平台元数据与核心入口文件（`executable` + `jar`）存在性校验（约 120 行）。

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - `tests/desktop/ocr-runtime.test.mjs`
- **核心验证场景与边界条件**：
  1. `molvec-component.json` 轻量化校验、`molvec.command` 与 `molvec.parse` 单元测试：验证 `molvec-component.json` 不含 `files`/`sources` 旧哈希表；验证 Windows (`bin/java.exe`)、macOS 扁平 JRE (`bin/java`) 与 macOS Bundle JRE (`Contents/Home/bin/java`)（含带空格/中文 `<jre>` 目录及含反斜杠字符的 macOS 绝对路径）的 `JAVA_HOME` 推导、JVM 参数构造、内存不足拦截 (`OCR_MEMORY`)、非法启动器路径拦截 (`OCR_COMPONENT_EXECUTABLE`) 及 MOL 文本解析。
  2. `createOcrRuntime` 跨平台未安装与平台/架构拦截测试：验证 `win32-x64`、`darwin-arm64`、`darwin-x64` 在目录不存在时 `capabilities()` 均返回 `status: 'not-installed'`；验证不支持的平台（`linux`）或架构（`win32-arm64`、`darwin-ia32`）抛出 `OCR_UNSUPPORTED`。
  3. `createOcrRuntime` 在无 JRE 哈希表条件下解析 `win32-x64`、`darwin-arm64`（Bundle 与 Flat 两种布局）和 `darwin-x64`（Bundle 与 Flat 两种布局）组件测试：验证任意合规 JRE 目录均可直接解析为 `ready`，验证 `componentSHA256` 等于实际 `jarSHA256`（当修改 `component.json` 附加字段时保持稳定，当磁盘 JAR 内容变化时更新），并覆盖含反斜杠 `\` 的 macOS 组件目录从 `select(root)` 到 `molvec.command` 的完整流程。
  4. 异常与边界拦截测试：验证 `component.json` 平台/架构缺失或不匹配 (`OCR_COMPONENT_UNAPPROVED`)、非法或绝对 `executable` 路径 (`OCR_COMPONENT_EXECUTABLE`)、缺失或空 `jar`/`java` 文件 (`ENOENT` / `OCR_COMPONENT_FILE`)、符号链接目录/文件拦截 (`OCR_COMPONENT_PATH` / `OCR_COMPONENT_FILE`)、非 Windows 下 `java` 缺少可执行权限位 (`OCR_COMPONENT_EXECUTABLE`) 以及 `0o111` 仅执行权限 `java` 文件正常解析。

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - “把这个 JRE 的哈希校验功能直接去掉就行了，不需要考虑挂木马的问题。你把它这个哈希校验直接删了，这样子就简单多了。”
  - “可以，现在把这剩下两个小问题修复一下”
- **澄清细节与确认结论**：
  - 已按用户明确指令删除 `desktop/ocr-runtime.cjs` 与 `desktop/ocr/molvec-component.json` 中的 JRE 文件哈希白名单校验与 316 项旧哈希表，并将 `componentSHA256` 直接关联为磁盘 JAR 的实际 SHA-256。
- **是否已获得用户开发确认**：是
