# Lactone Studio (LS)

**面向计算化学、量子化学与分子模拟工作流的跨平台（macOS / Windows / Linux）一体化桌面工作台**

> [!IMPORTANT]
> **非官方修改版声明（Unofficial Modified Version Notice — 遵循 `LICENSE.txt` 第七条）**
> - **本项目性质**：**Lactone Studio (LS)** 是基于 **Ester Studio (ES) v2.0.3** 源码改造的**非官方修改版（Unofficial Modified Version）**。
> - **修改者与版本标识**：修改者 [`mcardZH`](https://github.com/mcardZH) · 当前修改版本 `v2.0.3-lactone.1`（基线版本 `v2.0.3`）。
> - **对应源码获取地址**：https://github.com/mcardZH/Lactone-Studio
> - **上游官方项目与原始作者**：上游软件 **Ester Studio (ES)**（历史名称 SY-Studio / SciYue）由原始作者兼著作权人 **Zixuan Zhang**（许可联系渠道：`ddwz@sciyue.cn`）开发并发布于官方仓库 https://github.com/Ahey1/Ester-Studio（基线版本对应发布页：https://github.com/Ahey1/Ester-Studio/releases/tag/v2.0.3）。
> - **官方身份免责声明**：本修改版由社区独立维护，**未获得原始作者审核、科学验证、支持或商业认可**；修改者不代表原始作者或官方发布渠道。使用者须自行核验计算输入、参数、单位与科学结论。

---

## 1. 项目简介与命名由来

在有机化学中，**内酯（Lactone）** 是 **酯（Ester）** 在分子内成环形成的同族演进化合物。**Lactone Studio (LS)** 以此命名，旨在致敬上游项目 **Ester Studio (ES)** 的科学计算设计基因，同时代表本项目在 **macOS 原生跨平台运行** 与 **AI 智能体人机同屏协作（MCP）** 方向上构建的完整工作流闭环。

### 本修改版（Lactone Studio）的核心改进
1. **macOS 原生全链路适配 (`darwin-arm64` Apple Silicon & `darwin-x64` Intel)**：
   - 解锁原版仅限 `win32-x64` 的平台限制，完整适配 macOS 原生进程身份探针（`sysctl` / `ioreg` / `ps`）与 POSIX 路径体系；
   - 实现 macOS 独立自包含 Python 3.12 科学计算引擎（`RDKit`、`ASE`、`Spglib`、`tblite`、`SciPy`、`NumPy`）及 Mach-O `@rpath` / `@loader_path` 动态库重定位；
   - 适配 macOS 原生 `GNU xTB` 半经验计算宿主、`MolVec` 离线化学结构图片识别（OCR）JRE 运行时以及 `Multiwfn` 波函数分析调用；
   - 提供一键式 macOS 应用打包脚本（`npm run package:mac`），可直接生成自包含签名的 `Lactone Studio.app` 与 `.dmg` 安装镜像。
2. **人机同屏协作 MCP 服务底座 (`desktop/mcp/`)**：
   - 内置零第三方依赖的标准 **Model Context Protocol (`stdio` JSON-RPC 2.0)** 服务端与 Electron 主进程↔React 渲染进程安全回环通信桥接层，支持 AI 客户端实时探活与读取工作台状态。
3. **100% 保持原版工程文件与科学工作流兼容**：
   - 完整保留 `.es` 默认新建工程扩展名及 `.sy` 历史工程文件读写兼容；
   - 内置无 Git 历史的上游源码包三方增量同步工具（`npm run upstream:*`）与多子代理独立盲审工作流（`npm run review:*`）。

---

## 2. 核心功能概览

| 模块 | 核心能力 |
| :--- | :--- |
| **2D / 3D 分子与周期性晶体建模** (`src/modeling/`, `desktop/chemistry/`) | 集成 Ketcher / Indigo 2D 结构绘制与 3D 实时互转、MolVec 离线文献结构图 OCR 识别；支持 CIF / POSCAR / CP2K / PDB / XYZ 等格式解析、空间群对称性识别、超胞构建、晶面切取（Slab）、键长/键角/二面角精确测量与坐标移动、冻结与柔性扫描约束设置。 |
| **Gaussian & ORCA 量化输入工作台** (`src/core/`, `src/web/`) | 涵盖单点能、几何优化、过渡态（TS/QST2/QST3）、频率、内禀反应坐标（IRC）、激发态（TDDFT/TDA/UKS）、弱相互作用（BSSE）等 12 类任务；内置方法与基组推荐、混合基组分配、ONIOM 多层建模、隐式溶剂模型及来源 `.chk`/输出文件级别继承。 |
| **半经验计算、构象搜索与反应路径** (`desktop/xtb-host.cjs`, `desktop/aiss-host.cjs`) | 内置 GNU xTB（GFN2-xTB / GFN1-xTB / GFN0-xTB / GFN-FF）快速预优化、分子动力学采样、混合构象搜索、aISS 双分子立体取向对接及 BPP 反应路径插值。 |
| **波函数、等值面与光谱后处理** (`src/results/`, `desktop/orbital-runtime.cjs`) | 解析 Gaussian / ORCA / xTB 输出与轨迹；联动外部 Multiwfn 实时渲染分子轨道（HOMO/LUMO/NTO）、电子密度、静电势（ESP）、IGM/mIGM 弱相互作用等值面及 Hirshfeld/Bader 电荷；支持 IR、Raman、UV-Vis、ECD、NMR 谱图展宽绘制与高清图像/数据导出。 |
| **任务中心与远程 Linux 超算调度** (`desktop/task-system/`) | 支持通过 SSH 直连远程 Linux 服务器或提交 Slurm 作业队列运行 Gaussian / ORCA 计算任务（Windows 下另支持本机与 WSL 环境）；支持实时日志监控、收敛曲线预览、异常诊断与结果文件一键取回后处理。 |
| **方法学文献引用自动收集** (`src/citations/`) | 根据当前工程实际使用的软件、泛函、基组、色散校正、溶剂模型与分析算法，自动追踪并导出可核查的 BibTeX / RIS / 文本参考文献列表。 |

---

## 3. 快速开始与构建指南

### 3.1 环境要求
- **操作系统**：macOS 13+（Apple Silicon `darwin-arm64` 或 Intel `darwin-x64`）、Windows 10/11 `x64` 或 Linux `x64`
- **Node.js**：`>= 22`（推荐 Node.js 24 LTS）
- **Python**：Python `3.12`（用于本地开发态科学计算引擎或 staging 打包）

### 3.2 安装依赖与开发模式启动

```bash
# 1. 安装前端与 Electron 依赖
npm ci
npm run prepare:desktop

# 2. (macOS) 构建并暂存本地自包含 Python 3.12 科学引擎与 xTB 运行时
npm run native:stage:darwin

# 3. 启动桌面端开发环境（支持热更新）
npm run desktop:dev
```

> 若在开发态使用自定义 Conda/虚拟环境（已安装 `numpy`, `scipy`, `rdkit`, `ase`, `spglib`, `tblite`），也可通过环境变量指定 Python 解释器启动：
> ```bash
> SCIYUE_PYTHON=/path/to/python3 npm run desktop:dev
> ```

### 3.3 运行测试与生产构建

```bash
# 运行全量单元测试套件（Node.js 主进程测试 + Vitest 前端测试）
npm test

# 执行 TypeScript 类型检查与前端生产构建
npm run build

# 在 macOS 上打包生成 Lactone Studio.app、.dmg 安装镜像与 安装说明 (INSTALL).txt
npm run package:mac

# 在 Windows (x64) 上暂存 Conda 科学栈并打包免安装便携版 .zip
npm run native:stage:conda -- --conda-prefix <conda_env_path> --platform win32-x64
npm run package:win

# 在 Linux (x64) 上暂存 Conda 科学栈并打包便携版 .tar.gz 与单文件 .AppImage
npm run native:stage:conda -- --conda-prefix <conda_env_path> --platform linux-x64
npm run package:linux
```

打包产物默认输出至 `release/darwin-arm64/`（或 `release/darwin-x64/`），包含：
- `Lactone Studio.app`（已自动嵌入 `scripts/portable/assets/lactone.icns` 专属内酯环应用图标及自包含 Python 3.12 + GNU xTB 运行时）；
- `Lactone-Studio-2.0.3-darwin-<arch>.dmg`（内置 `Lactone Studio.app`、`Applications` 拖拽快捷方式及 `安装说明 (INSTALL).txt`）；
- `安装说明 (INSTALL).txt`（独立输出的 macOS 安装与使用指南）。

> **macOS 首次安装与解除安全隔离提示**：
> 将 `Lactone Studio.app` 拖入 `/Applications`（应用程序）后，由于社区开源构建使用本地自签名（Ad-hoc Signature），若首次打开提示“已损坏”或“未验证开发者”，请在终端运行以下命令解除隔离属性：
> ```bash
> sudo xattr -rd com.apple.quarantine "/Applications/Lactone Studio.app"
> ```

### 3.4 在 macOS 上通过 Homebrew 安装 Multiwfn（可选，波函数与轨道分析）

如需使用分子轨道（HOMO/LUMO/NTO）、静电势（ESP）、电子密度、IGM/mIGM 弱相互作用等值面及原子电荷等后处理功能，可通过社区维护的 Homebrew Tap（[`digital-chemistry-laboratory/homebrew-multiwfn`](https://github.com/digital-chemistry-laboratory/homebrew-multiwfn)）在 macOS 上编译安装命令行版 `Multiwfn`：

```bash
# 添加 Tap 并启用 OpenMP 多线程支持编译安装（首次从源码编译需数分钟）
brew tap digital-chemistry-laboratory/multiwfn
brew install --HEAD multiwfn --with-openmp

# 后续如需跟进上游更新：
# brew upgrade multiwfn --fetch-HEAD --with-openmp
```

- **免配置自动识别**：安装完成后，Lactone Studio 启动时会自动探测 Homebrew 默认安装路径（Apple Silicon：`/opt/homebrew/opt/multiwfn/bin/multiwfn` 或 `/opt/homebrew/bin/multiwfn`；Intel Mac：`/usr/local/opt/multiwfn/bin/multiwfn` 或 `/usr/local/bin/multiwfn`），并自动关联 `<brew_prefix>/etc/multiwfn/settings.ini` 配置文件，**无需手动设置系统环境变量 `Multiwfnpath`**。
- **手动指定路径（可选）**：若安装在其他自定义目录，或升级版本后需要重新指定，可在软件左上角 **「LS（全局设置）」->「工具与文件」** 中手动选择 `multiwfn` 可执行文件。

### 3.5 GitHub Actions 跨平台自动编译与分发 (`.github/workflows/release.yml`)

仓库内置了统一的跨平台自动化构建与发布流水线 [.github/workflows/release.yml](.github/workflows/release.yml)：
- **触发方式**：
  1. 推送 `v*` 版本标签（如 `git tag v2.0.3-lactone.1 && git push origin v2.0.3-lactone.1`），自动并行构建 **macOS (`arm64` + `x64`) + Windows (`x64`) + Linux (`x64`)** 全平台安装包并汇总至同一 GitHub Release；
  2. 在 GitHub 仓库 **Actions -> Build & Release Cross-Platform Apps -> Run workflow** 手动触发（支持通过 `target_platform` 选择 `all` 或单独构建 `macos-arm64` / `macos-x64` / `windows-x64` / `linux-x64`，可选填写 `release_tag` 发布到 GitHub Releases）。
- **自动化产物**：
  - **macOS (`darwin-arm64` / `darwin-x64`)**：`Lactone-Studio-<ver>-darwin-<arch>.dmg`、`*.app.zip` 与 `INSTALL-macos-<arch>.txt`；
  - **Windows (`win32-x64`)**：免安装绿色便携包 `Lactone-Studio-<ver>-win32-x64.zip` 与 `INSTALL-windows-x64.txt`；
  - **Linux (`linux-x64`)**：单文件可执行包 `Lactone-Studio-<ver>-linux-x64.AppImage`、便携压缩包 `Lactone-Studio-<ver>-linux-x64.tar.gz` 与 `INSTALL-linux-x64.txt`；
  - 统一汇总校验清单 `SHA256SUMS.txt`。

关于原版源码快照的完整离线重构建流程，请同时参阅 [BUILDING.md](BUILDING.md)。

---

## 4. 架构与开发者文档索引

- [AGENTS.md](AGENTS.md)：AI 智能体与开发者协作宪章、规范化开发三步走流程与常用命令速查
- [CONTRIBUTING.md](CONTRIBUTING.md)：分支规范、测试要求、Git Hooks 与多子代理代码复核指南
- [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)：前后端目录职责拆解、IPC 通信机制与科学计算后端架构详解
- [docs/MACOS_PORTING_ROADMAP.md](docs/MACOS_PORTING_ROADMAP.md)：macOS 平台兼容性矩阵与分阶段移植方案
- [docs/MCP_COLLABORATION_ROADMAP.md](docs/MCP_COLLABORATION_ROADMAP.md)：人机同屏协作 MCP 服务端架构与分阶段路线图
- [BUILDING.md](BUILDING.md)：上游源码快照本地原生运行时重构建说明

---

## 5. 科研引用要求（Citation — 遵循 `LICENSE.txt` 第八条）

根据根目录 [LICENSE.txt](LICENSE.txt) 第八条规定，**使用本软件（含本修改版 Lactone Studio）开展研究并发表相关论文时，必须在论文正文中明确说明使用了 Ester Studio**，并按下列规则提供引用（修改版保留对原版 Ester Studio 的适用引用，使用者可在此基础上附加说明使用了本修改版）：

1. **原版软件必引条目（Ester Studio）**：
   - 若论文首次正式投稿时，Ester Studio 官方软件论文尚未正式发表，请引用官方 GitHub 项目页面：
     > Zixuan Zhang. *Ester Studio* (v2.0.3), computer software, https://github.com/Ahey1/Ester-Studio (contact: ddwz@sciyue.cn).
   - 若投稿时官方软件论文已正式发表，请采用其正式出版引文。
2. **本修改版附加说明（可选，推荐在正文或方法学部分补充）**：
   - 如使用了本项目的 macOS 原生移植或扩展特性，可在引用上述原版软件的同时补充说明：
     > macOS adaptation via *Lactone Studio* (`v2.0.3-lactone.1`, unofficial modified version of Ester Studio maintained by mcardZH, https://github.com/mcardZH/Lactone-Studio).
3. **第三方科学程序与方法学引用**：
   - 引用 Ester Studio / Lactone Studio **不替代**实际使用的第三方计算程序（如 Gaussian、ORCA、xTB、Multiwfn、RDKit、ASE、Spglib）、泛函、基组及分析方法各自要求的文献引用。您可使用软件工作台右上角的 **「导出文献」** 功能一键生成当前工程涉及的完整方法学参考文献。

---

## 6. 软件许可协议与第三方声明（License & Notices）

1. **主软件许可协议**：
   - 本仓库继续沿用并严格遵守根目录的 [LICENSE.txt](LICENSE.txt) —— **《Ester Studio（ES）免费源码公开许可协议 1.0》**（Copyright (c) 2026 Zixuan Zhang）。
   - **核心条件提示**：
     - 允许免费使用、研究、修改和符合条件的免费再分发；
     - **严禁未经原作者（Zixuan Zhang）事先书面同意销售本软件或修改版**（包括源码、可执行程序或以付费下载/会员/包装外壳等名义实质销售软件副本，详见第四条）；
     - 分发修改版或对外提供修改版在线软件功能时，必须随附或免费提供对应源码，并显著标注“非官方修改版”（详见第五条、第七条）；
     - 发表相关研究论文须履行科研引用义务（详见第八条）。
2. **第三方组件许可与源码索引**：
   - 软件所集成或调用的第三方开源组件（包括但不限于 Electron、Chromium、React、3Dmol.js、Ketcher、Indigo、RDKit、ASE、Spglib、SciPy、OpenBLAS、GNU xTB、MolVec 等）各自保留其原始许可证、版权声明与例外条款，完整声明与对应源码索引集中于 [licenses/](licenses/) 目录（详见 [licenses/README.md](licenses/README.md) 与 [licenses/THIRD_PARTY_RUNTIME_TERMS.md](licenses/THIRD_PARTY_RUNTIME_TERMS.md)）。
   - Multiwfn、Gaussian 与 ORCA 属于用户自行获取并配置的外部程序，不包含在本仓库分发物内。
