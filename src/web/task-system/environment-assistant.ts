import type { EnvironmentView } from "../../task-system/application-contracts";

export const environmentPresets = [
	{
		id: "windows",
		name: "Windows 本机",
		fields: { connectionKind: "local", schedulerKind: "none" }
	},
	{ id: "wsl", name: "WSL2", fields: { connectionKind: "wsl", schedulerKind: "none" } },
	{ id: "ssh", name: "SSH 普通后台", fields: { connectionKind: "ssh", schedulerKind: "none" } },
	{ id: "slurm", name: "SSH + Slurm", fields: { connectionKind: "ssh", schedulerKind: "slurm" } }
] as const;

export function detectClientPlatform(explicitPlatform?: string): "darwin" | "win32" | "linux" {
	const raw =
		explicitPlatform ??
		(typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)
			? `${navigator.platform || ""} ${navigator.userAgent || ""}`
			: typeof process !== "undefined" && typeof process.platform === "string"
				? process.platform
				: "");
	const lower = raw.toLowerCase();
	if (lower.includes("darwin") || lower.includes("mac")) return "darwin";
	if (lower.includes("win")) return "win32";
	if (lower.includes("linux")) return "linux";
	return "win32";
}

export function isMacClientPlatform(explicitPlatform?: string): boolean {
	return detectClientPlatform(explicitPlatform) === "darwin";
}

export function isSshOnlyClientPlatform(explicitPlatform?: string): boolean {
	return detectClientPlatform(explicitPlatform) !== "win32";
}

export function availableEnvironmentPresets(platform?: string) {
	if (isSshOnlyClientPlatform(platform)) {
		return environmentPresets.filter((preset) => preset.fields.connectionKind === "ssh");
	}
	return [...environmentPresets];
}
export const environmentHelp: Record<string, string> = {
	user: "WSL 执行用户是发行版内的账户；请明确填写实际用户。",
	authentication: "SSH Agent 不需要密码框。私钥文件始终从本机选择，密码与口令只交给凭据入口。",
	workingRoot: "检测或实际提交时自动逐级创建缺失的父目录，已有目录复用。每次任务使用独立子目录；WSL/SSH 路径属于目标环境。",
	schedulerKind: "普通后台直接运行；Slurm 交给已有调度系统，不会在登录节点代跑。",
	slurm:
		"分区、账户和 QoS 依站点规则填写。申请时限是运行上限，不是预计完成时间；留空不表示无限资源。",
	slurmMemoryPolicy:
		"按计算输入申请会传递 --mem。由站点管理不传 --mem，计算输入预算仍保留；调度器分配内存未核实，不表示无限内存。须由客户确认站点政策。",
	initialization:
		"填写实际安装要求的初始化命令，仅用于本次启动。留空继承非交互环境，不等同于交互终端。",
	calculationTemplate:
		"标准模板包含本次真实输入、输出、资源和初始化。自定义模板仅使用公布变量，不改变 ES 的管理外层。",
	scriptTemplate: "兼容已有 Slurm 受管外壳，必须保留一次 runnerPath 及已使用的调度字段。",
	submitCommandTemplate:
		"仅适用于 SSH + Slurm；返回单一可核对的 Job ID，继续由 ES 查询、停止和管理文件。",
	gaussianMemory: "Gaussian 内存是本次作业总内存声明。",
	orcaMemory: "ORCA MaxCore 是每进程主要工作内存，不能当成整个作业总内存。"
};
export const calculationTemplateVariables = [
	{
		name: "standardScript",
		description: "本次完整标准计算脚本，含输入/输出、软件入口、初始化与资源；必须恰好一次"
	},
	{ name: "workingPath", description: "本次任务工作目录，自动按目标 shell 引用，不再套引号" }
];
export const submitTemplateVariables = [
	{ name: "submitScriptPath", description: "本次已登记 Slurm 提交脚本，自动引用，不再套引号" },
	{ name: "workingPath", description: "本次已登记工作目录，自动引用，不再套引号" }
];
/** Examples are display-only; callers never copy them into configuration values. */
export function environmentPathPlaceholder(
	environment: Pick<EnvironmentView, "engineId" | "connectionKind">,
	field: "executable" | "workingRoot" | "privateKeyPath",
	platform?: string
) {
	if (field === "privateKeyPath") {
		const clientPlatform = detectClientPlatform(platform);
		if (clientPlatform === "darwin") return "例如 /Users/your-user/.ssh/id_ed25519";
		if (clientPlatform === "linux") return "例如 /home/your-user/.ssh/id_ed25519";
		return "例如 C:\\Users\\your-user\\.ssh\\id_ed25519";
	}
	if (environment.connectionKind === "local") {
		if (field === "workingRoot") return "例如 D:\\ES-Tasks";
		return environment.engineId === "gaussian"
			? "例如 C:\\G16W\\g16.exe"
			: "例如 D:\\ORCA611\\orca.exe";
	}
	if (field === "workingRoot") return "例如 /home/your-user/es-tasks";
	return environment.engineId === "gaussian" ? "例如 /opt/gaussian/g16/g16" : "例如 /opt/orca/orca";
}
export function initializationSnippets(
	environment: Pick<EnvironmentView, "engineId" | "connectionKind">
) {
	if (environment.connectionKind === "local")
		return [
			{
				id: "powershell",
				name: "PowerShell 环境变量",
				text: "# 仅填写当前安装要求的变量；下面是注释示例，不会自动配置\n# $env:PATH = 'D:\\实际安装目录;' + $env:PATH\n# $env:变量名 = '实际值'\n"
			}
		];
	return environment.engineId === "gaussian"
		? [
				{
					id: "gaussian",
					name: "Gaussian 安装初始化",
					text: "# bash：填写实际安装根及其提供的初始化文件后再取消注释\n# export g16root=/实际安装根\n# source /实际安装根/g16/bsd/g16.profile\n"
				},
				{
					id: "module",
					name: "站点 module",
					text: "# bash：先加载站点要求的 module 初始化，再填写真实模块名\n# source /站点实际路径/modules.sh\n# module load 实际软件模块名\n"
				}
			]
		: [
				{
					id: "orca",
					name: "ORCA / MPI 环境",
					text: "# bash：仅填写实际 ORCA 安装要求的匹配 MPI 与动态库环境\n# export PATH=/实际ORCA安装目录:$PATH\n# export LD_LIBRARY_PATH=/匹配MPI库目录:${LD_LIBRARY_PATH:-}\n# 不在这里设置本次进程数\n"
				},
				{
					id: "module",
					name: "站点 module",
					text: "# bash：先加载站点要求的 module 初始化，再填写真实模块名\n# source /站点实际路径/modules.sh\n# module load 实际软件模块名\n"
				}
			];
}
const scriptKeys = [
	"initialization",
	"scriptTemplate",
	"calculationTemplate",
	"submitCommandTemplate"
] as const;
const safeKeys = [
	"environmentId",
	"revision",
	"displayName",
	"engineId",
	"connectionKind",
	"schedulerKind",
	"host",
	"port",
	"user",
	"distribution",
	"executable",
	"workingRoot",
	"partition",
	"account",
	"qos",
	"timeLimit",
	"slurmMemoryPolicy",
	"authentication",
	"privateKeyPath",
	"siteId",
	"siteRevision"
] as const;
export function configurationWithoutSecrets(environment: EnvironmentView, includeScripts = false) {
	const safe: Record<string, unknown> = {};
	const containsSecret = (value: unknown) =>
		typeof value === "string" &&
		/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:password|passwd|passphrase|token|api[_-]?key|secret)\b\s*[:=]\s*\S+/i.test(
			value
		);
	for (const key of safeKeys)
		if (environment[key] !== undefined)
			safe[key] = containsSecret(environment[key]) ? "[检测到疑似凭据，已排除]" : environment[key];
	if (includeScripts)
		for (const key of scriptKeys) {
			const value = environment[key] || "";
			safe[key] = containsSecret(value) ? "[检测到疑似凭据，已排除]" : value;
		}
	return safe;
}
/** The sole complete customer-facing MD, available before save or manager acquisition. */
export function environmentConfigurationMarkdown(
	environment?: EnvironmentView,
	includeScripts = false,
	source: "saved" | "draft" = "saved"
): string {
	return `# Ester Studio 执行环境配置说明

配置格式：schemaVersion 1；适用本批已实现的 Gaussian / ORCA。请将此文档交给没有项目上下文的 LLM 或电脑 Agent，并提供下方资料。整理配置不会启动科学计算。

## 支持范围

| 连接方式 | 作业管理 | 路径归属 |
| --- | --- | --- |
| Windows 本机（local） | 普通后台（none） | ES 所在 Windows 的绝对路径 |
| WSL2（wsl） | 普通后台（none） | 指定发行版内的 POSIX 绝对路径 |
| SSH 服务器（ssh） | 普通后台（none）或 Slurm（slurm） | 实际远端 Linux 的 POSIX 绝对路径 |

连接方式与调度方式在配置中分别保存，界面用“Windows 本机、WSL2、SSH服务器、SSH + Slurm”四种环境类型组合呈现。云平台品牌不是调度协议。PBS/LSF、跳板、多子作业扇出及新机器 API 不在本版能力内，不能伪装普通后台或在登录节点直跑。不安装、升级外部软件，不修改系统配置，不新建远端目录，不提交或停止任务。只能在客户已授权范围只读核对；不能访问机器时据资料列必要缺口，不声称已检测。

## 请向客户收集的资料

| 字段 / 界面名 | 类型及条件 | 如何填写 / 留空行为 |
| --- | --- | --- |
| environmentId / revision | 新配置固定为空字符串 / 数字 0 | 导入应用为新草稿，不覆盖已有环境 |
| displayName / 环境名称 | 非空字符串 | 客户未提供时，可按实际软件与连接方式给出可修改的建议名称；不能仅因未指定名称而追问或阻塞配置 |
| engineId / 计算软件 | gaussian 或 orca | 必须与实际安装匹配，不猜版本 |
| connectionKind / 连接方式 | local / wsl / ssh | 选择实际已有环境 |
| schedulerKind / 作业管理 | none / slurm | 仅 ssh 可选 slurm |
| executable / 软件可执行文件 | 非空绝对路径 | 指向目标环境实际软件入口，不能填占位路径 |
| workingRoot / 工作父目录 | 非空绝对路径 | 检测或实际提交时逐级创建缺失目录，已有目录复用；保存和预览不创建。每次任务产生独立子目录，不填某个旧任务目录 |
| distribution / WSL 发行版 | wsl 必填字符串，其余空字符串 | 实际发行版名，不自动安装 |
| user / 执行用户 | wsl / ssh 必填，其余空字符串 | WSL 是发行版内用户，不暗设 root |
| host / 主机 | ssh 必填，其余空字符串 | 实际主机名或地址 |
| port / 端口 | 数字整数 1–65535；ssh 必填 | 已确认默认端口才用 22，不从其他站点复制 |
| authentication / 认证方式 | agent / password / private-key | 非 ssh 用 agent；秘密不放 JSON |
| privateKeyPath / 本机私钥文件 | private-key 必填，其余空字符串 | 始终是 ES 所在 Windows 的本机绝对文件路径，不是私钥正文 |
| partition / 分区 | slurm 字符串，其余空字符串 | 按实际站点要求，空值服从站点规则 |
| account / 账户 | slurm 字符串，其余空字符串 | 站点未要求可留空，不复制其他客户账户 |
| qos / QoS | slurm 字符串，其余空字符串 | 按站点规则；留空不表示无限资源 |
| timeLimit / 默认申请时限 | slurm 字符串，其余空字符串 | Slurm 时间格式，运行上限，不是 ETA |
| slurmMemoryPolicy / 内存申请 | input-request / site-managed；ssh+slurm 可选，其余模式省略 | 缺省 input-request：按计算输入预算申请调度内存；site-managed：由站点管理，不传 --mem。必须由客户确认实际站点政策，不按平台品牌推断 |
| initialization / 初始化命令 | 字符串，可空 | 安装要求的 source/module/export 或 PowerShell；空值继承非交互启动环境，不保证等同 .bashrc |
| calculationTemplate / 运行模板 | 字符串，可空 | 空值使用系统标准计算脚本；非空按下文变量展开 |
| submitCommandTemplate / 自定义提交 | 字符串，可空，仅 ssh+slurm | 空值 ES 标准提交；非空须保完整受管 Slurm 生命周期 |
| scriptTemplate / 兼容 Slurm 外壳 | 字符串，可空，仅已有兼容配置使用 | 旧受管 runner 模板沿原解释，不是计算模板；新配置留空 |
| scratchRoot / 历史字段 | 新配置空字符串 | 不配置外置 scratch；本次产物由工作目录管理。旧数据保留来源，不能据旧字段扩展新配置 |

资源（线程/进程、Gaussian 总内存、ORCA 每进程 MaxCore）来自单次提交的实际输入，不是环境永久默认。归档根来自任务库，环境页没有额外归档根字段。Scratch 不提供外置父目录。

Slurm 内存申请策略与科学输入预算分别保留。input-request 沿计算输入申请 --mem；site-managed 不传 --mem，但 Gaussian / ORCA 输入中的内存预算仍原样保留，调度器实际分配内存未核实，不表示无限内存或已经验证资源可用。只有客户明确确认站点政策才选择 site-managed；旧运行继续使用原冻结快照。自定义脚本中显式 --mem 或其他内存申请与 site-managed 冲突时会拒绝，不通过隐藏脚本绕过。内存策略是枚举，不填数字0，不改变核数或预算。下文初始化示例只说明语法，不设默认资源。

## 严格 JSON 格式

顶层只能使用 schemaVersion（数字 1）、requiredCapabilities（数组，新配置为空数组）和 environment（上述实际配置字段对象）。使用双引号，不带注释、尾逗号或 Markdown 围栏；枚举用表中的英文值，port/revision 用数字。schemaVersion:1 表示格式版本，不代表已检测。environmentId 为空字符串、revision 为 0。所有适用必填值必须来自客户资料或真实核对；不适用字段按表留空。check、templateVariables、密码、口令、私钥正文、token、Cookie 和任何凭据不得写入 JSON。未知必填项时先提出必要问题，不能输出含占位路径、猜测账号或伪造可导入结果的 JSON。保留原始字段值与依据，不通过改科学方法凑成可用配置。

Windows 路径在字段核对表中必须用行内代码展示，逐个保留原反斜杠，不能将反斜杠当作 Markdown 转义后丢失。写入 JSON 字符串时按 JSON 规则将每个反斜杠转义为两个反斜杠；核对表与 JSON 解码后的实际路径必须完全一致。以下仅说明字符串转义，不是可用路径或可导入配置：核对表中的 \`C:\\A\\B\` 对应 JSON 字符串 \`"C:\\\\A\\\\B"\`，二者解码后的实际值相同。

## 初始化与运行模板

四种启动骨架是 Windows 本机、WSL2、SSH 普通后台、SSH+Slurm。只插入实际适用的初始化；没有安装路径或 module 名称就先询问，不猜值。插入前预览，保留客户手改。

运行模板为空使用系统标准。非空可使用 {standardScript}（必须恰好一次，展开为本次完整标准计算脚本，含真实软件入口、输入/输出、资源及初始化）和 {workingPath}（自动按目标 shell 安全引用的本次任务目录，必须作为独立 token，不再加引号）。只使用这两个变量，未知变量拒绝展开。Windows 是 PowerShell，WSL/SSH 是 bash。ES 的身份、回执、停止及目录管理仍在受管外层，不允许模板另起无法跟踪的后台计算或把输出转移到未登记目录。最终展开字节在提交页核对。

以下均为注释示例，仅说明 shell 语法。必须用已核对的实际安装路径、库与模块名替换后，才可取消注释；不会自动写入配置或启动软件。环境变量属于 initialization 字符串，不新增配置字段。

Windows / PowerShell（Gaussian 或 ORCA，按安装需要）：

\`\`\`powershell
# $env:PATH = 'D:\\实际软件目录;' + $env:PATH
# $env:变量名 = '实际值'
# 若安装提供 PowerShell 初始化脚本，可按实际安装说明加载
\`\`\`

WSL / SSH / bash（Gaussian）：

\`\`\`bash
# export g16root=/实际安装根
# source /实际安装根/g16/bsd/g16.profile
\`\`\`

WSL / SSH / bash（ORCA / 匹配 MPI）：

\`\`\`bash
# export PATH=/实际ORCA目录:$PATH
# export LD_LIBRARY_PATH=/匹配MPI库目录:$LD_LIBRARY_PATH
\`\`\`

站点 module（仅站点实际提供时）：

\`\`\`bash
# source /站点实际路径/modules.sh
# module load 实际软件模块名
\`\`\`

SSH+Slurm 自定义提交命令只支持 {submitScriptPath} 和 {workingPath}，路径变量均为独立 token 并自动引用。命令须向 stdout 返回一个可识别、可核对的 Slurm Job ID，不能扇出多个作业；提交脚本、输入、工作目录均由本次 ES 提交意图登记，查询、停止、归档和清空继续针对同一任务。命令退出成功不等于计算成功。回执不明保原意图待核实，不自动重提。PBS/LSF、代发模式或未登记产物位置不支持完整管理。当前 Slurm 仅做配置/协议核验，不能据此声称真实站点计算已通过。

## 手填、导入与检查步骤

1. 依据资料表填字段；路径由对应环境的选择器核对，私钥始终从本机选择。
2. 也可在执行环境点“导入”，选择文件或粘贴严格 JSON，两者共用校验及独立预览；关闭预览不改已有环境。
3. 点“应用到新草稿”才填入新草稿，仍未保存。切连接模式保各自草稿，不借其他主机路径补值。
4. 点“保存环境”持久保存；这不证明可连通。没有管理权仍可下载本说明，编辑/保存按任务库权限处理。
5. 单独点“检测环境”；先核主机指纹及凭据，结果只证明本次明确的连接、入口和版本证据，不代表科学计算通过。
6. 提交前核最终输入、依赖、实际资源与展开脚本。真实计算需要另行授权；未做的检测、站点实机和科学运行明确写未测。

生成配置、导入预览、应用草稿、保存、连接/软件检测和真实计算通过是独立层次。JSON 导出只取实际已保存配置，不导出未保存草稿；无保存环境时不能导出伪空配置。“配置助手”先预览当前表单的无秘密字段，标明其为草稿，不代表已保存或已检测；“更多”可另取当前已保存配置的说明。两种说明复用本 MD，脚本默认排除；只有客户主动选择且核对后才加入，秘密永远排除。JSON 保存与导入保留脚本原始字节，说明中排除疑似凭据不回写配置。

## 常见缺口与助手输出要求

先指出缺少的真实入口/工作父目录、发行版用户、SSH 认证或 Slurm 站点规则；必要问题集中列出。管理员的交互终端脚本不一定适用非交互运行。Windows 路径不可作为 SSH/WSL 软件路径。privateKeyPath 是文件位置，不能粘贴密钥内容。Slurm 空值不是无限申请。

请按顺序给：字段→值→依据/核对情况→留空行为表（Windows 路径用行内代码保留原反斜杠）；必要初始化及影响；仅在所有适用必填资料齐全时给严格 JSON；待 ES 实际检测项。环境名称允许按实际软件与连接方式给可修改建议，不单独构成待补资料或阻塞项。不在任何输出藏秘密，不声称保存/导入就已运行成功。
${environment ? `\n## 当前${source === "draft" ? "表单草稿" : "已保存"}的无秘密配置预览\n\n${source === "draft" ? "这是当前表单草稿，尚未据此保存或检测。" : "这是已保存配置，保存不代表已检测。"}以下仅供核对，重新导入会应用到新草稿。${includeScripts ? "已主动选择加入脚本，请逐项核对。" : "初始化与自定义脚本未附带。"}\n\n\`\`\`json\n${JSON.stringify(configurationWithoutSecrets(environment, includeScripts), null, 2)}\n\`\`\`\n` : ""}`;
}
export function environmentPrompt(
	environment: EnvironmentView,
	_field?: string,
	includeScripts = false
) {
	return environmentConfigurationMarkdown(environment, includeScripts);
}
