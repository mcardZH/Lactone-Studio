import type {
	EnvironmentBrowseResult,
	EnvironmentSecretPayload,
	EnvironmentView,
	SiteProfileView,
	TaskCenterView,
	TaskSystemBridge
} from '../../task-system/application-contracts';
import {
	defaultEnvironmentDisplayName,
	environmentDraftIssues,
	environmentMode,
	isDefaultEnvironmentDisplayName,
	newEnvironment,
	type EnvironmentMode
} from '../task-system/environment-draft';

export type EnvironmentManageAction =
	| 'list'
	| 'get'
	| 'create'
	| 'update'
	| 'delete'
	| 'check'
	| 'trust-host-key'
	| 'browse';

export const ENVIRONMENT_MANAGE_ACTIONS: readonly EnvironmentManageAction[] = Object.freeze([
	'list',
	'get',
	'create',
	'update',
	'delete',
	'check',
	'trust-host-key',
	'browse'
]);

/** Fields an MCP client may set; secrets travel separately and are never stored here. */
export interface EnvironmentPatch {
	displayName?: string;
	mode?: EnvironmentMode;
	engineId?: EnvironmentView['engineId'];
	connectionKind?: EnvironmentView['connectionKind'];
	schedulerKind?: EnvironmentView['schedulerKind'];
	host?: string;
	port?: number;
	user?: string;
	distribution?: string;
	executable?: string;
	workingRoot?: string;
	partition?: string;
	account?: string;
	qos?: string;
	timeLimit?: string;
	slurmMemoryPolicy?: NonNullable<EnvironmentView['slurmMemoryPolicy']>;
	initialization?: string;
	calculationTemplate?: string;
	submitCommandTemplate?: string;
	authentication?: EnvironmentView['authentication'];
	privateKeyPath?: string;
}

export interface EnvironmentManageParams {
	action: EnvironmentManageAction;
	environmentId?: string;
	expectedRevision?: number;
	environment?: EnvironmentPatch;
	secret?: EnvironmentSecretPayload;
	challengeId?: string;
	fingerprint?: string;
	browsePurpose?: 'executable' | 'working-root' | 'private-key';
	browsePath?: string;
	confirm?: boolean;
	openTaskCenter?: boolean;
}

const STRING_FIELDS = [
	'displayName',
	'host',
	'user',
	'distribution',
	'executable',
	'workingRoot',
	'partition',
	'account',
	'qos',
	'timeLimit',
	'initialization',
	'calculationTemplate',
	'submitCommandTemplate',
	'privateKeyPath'
] as const;
const ENUM_FIELDS: Record<string, readonly string[]> = {
	mode: ['local', 'wsl', 'ssh', 'slurm'],
	engineId: ['gaussian', 'orca'],
	connectionKind: ['local', 'wsl', 'ssh'],
	schedulerKind: ['none', 'slurm'],
	authentication: ['agent', 'password', 'private-key'],
	slurmMemoryPolicy: ['input-request', 'site-managed']
};
const MAX_BROWSE_ENTRIES = 500;

function fail(message: string, code: string): never {
	throw Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(payload: Record<string, unknown>, key: string, max: number): string | undefined {
	const raw = payload[key];
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\r\n\0]/.test(raw))
		fail(`${key} must be a non-empty single-line string`, 'INVALID_ENVIRONMENT_ARGUMENT');
	return raw.trim();
}

function normalizePatch(raw: unknown): EnvironmentPatch {
	if (!isRecord(raw)) fail('environment must be an object', 'INVALID_ENVIRONMENT_ARGUMENT');
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === 'port') {
			if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535)
				fail('environment.port must be an integer between 1 and 65535', 'INVALID_ENVIRONMENT_ARGUMENT');
			patch.port = value;
		} else if (key in ENUM_FIELDS) {
			if (typeof value !== 'string' || !ENUM_FIELDS[key].includes(value))
				fail(`environment.${key} must be one of: ${ENUM_FIELDS[key].join(', ')}`, 'INVALID_ENVIRONMENT_ARGUMENT');
			patch[key] = value;
		} else if ((STRING_FIELDS as readonly string[]).includes(key)) {
			if (typeof value !== 'string' || value.includes('\0'))
				fail(`environment.${key} must be a string`, 'INVALID_ENVIRONMENT_ARGUMENT');
			patch[key] = value;
		} else {
			fail(`Unknown environment field "${key}"`, 'UNKNOWN_ENVIRONMENT_FIELD');
		}
	}
	if (patch.mode !== undefined && (patch.connectionKind !== undefined || patch.schedulerKind !== undefined))
		fail('environment.mode cannot be combined with connectionKind/schedulerKind', 'INVALID_ENVIRONMENT_ARGUMENT');
	return patch as EnvironmentPatch;
}

function normalizeSecret(raw: unknown): EnvironmentSecretPayload {
	if (!isRecord(raw)) fail('secret must be an object', 'INVALID_ENVIRONMENT_ARGUMENT');
	const out: EnvironmentSecretPayload = { remember: raw.remember === true };
	if (raw.remember !== undefined && typeof raw.remember !== 'boolean')
		fail('secret.remember must be a boolean', 'INVALID_ENVIRONMENT_ARGUMENT');
	for (const key of Object.keys(raw)) {
		if (!['password', 'privateKeyPassphrase', 'remember'].includes(key))
			fail(`Unknown secret field "${key}"`, 'UNKNOWN_ENVIRONMENT_FIELD');
	}
	for (const key of ['password', 'privateKeyPassphrase'] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0'))
			fail(`secret.${key} must be a non-empty string`, 'INVALID_ENVIRONMENT_ARGUMENT');
		out[key] = value;
	}
	if ((out.password === undefined) === (out.privateKeyPassphrase === undefined))
		fail('secret requires exactly one of password or privateKeyPassphrase', 'INVALID_ENVIRONMENT_ARGUMENT');
	return out;
}

/** Defensive renderer-side validation mirroring the MCP protocol layer. */
export function normalizeEnvironmentManageParams(payload: Record<string, unknown>): EnvironmentManageParams {
	const action = typeof payload.action === 'string' ? payload.action.trim() : '';
	if (!(ENVIRONMENT_MANAGE_ACTIONS as readonly string[]).includes(action))
		fail(`action must be one of: ${ENVIRONMENT_MANAGE_ACTIONS.join(', ')}`, 'INVALID_ENVIRONMENT_MANAGE_ACTION');
	const params: EnvironmentManageParams = { action: action as EnvironmentManageAction };
	const environmentId = optionalString(payload, 'environmentId', 200);
	if (environmentId !== undefined) params.environmentId = environmentId;
	if (['get', 'update', 'delete'].includes(action) && !environmentId)
		fail(`environmentId is required when action is "${action}"`, 'MISSING_ENVIRONMENT_ID');
	if (payload.expectedRevision !== undefined) {
		if (!Number.isInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 0)
			fail('expectedRevision must be a non-negative integer', 'INVALID_ENVIRONMENT_ARGUMENT');
		params.expectedRevision = payload.expectedRevision as number;
	}
	if (payload.environment !== undefined) params.environment = normalizePatch(payload.environment);
	if (action === 'create' && !params.environment)
		fail('environment is required when action is "create"', 'MISSING_ENVIRONMENT');
	if (payload.secret !== undefined) params.secret = normalizeSecret(payload.secret);
	if (action === 'update' && !params.environment && !params.secret)
		fail('update requires environment fields and/or secret', 'MISSING_ENVIRONMENT');
	if ((action === 'check' || action === 'browse') && !environmentId && !params.environment)
		fail(`${action} requires environmentId or environment`, 'MISSING_ENVIRONMENT');
	if (action === 'trust-host-key') {
		params.challengeId = optionalString(payload, 'challengeId', 200);
		params.fingerprint = optionalString(payload, 'fingerprint', 512);
		if (!params.challengeId || !params.fingerprint)
			fail('trust-host-key requires challengeId and fingerprint from a previous check', 'INVALID_ENVIRONMENT_ARGUMENT');
	}
	if (action === 'browse') {
		const purpose = payload.browsePurpose;
		if (purpose !== 'executable' && purpose !== 'working-root' && purpose !== 'private-key')
			fail('browsePurpose must be one of: executable, working-root, private-key', 'INVALID_ENVIRONMENT_ARGUMENT');
		params.browsePurpose = purpose;
		const browsePath = optionalString(payload, 'browsePath', 4096);
		if (browsePath !== undefined) params.browsePath = browsePath;
	}
	if (payload.confirm !== undefined && typeof payload.confirm !== 'boolean')
		fail('confirm must be a boolean', 'INVALID_ENVIRONMENT_ARGUMENT');
	params.confirm = payload.confirm === true;
	if ((action === 'delete' || action === 'trust-host-key') && !params.confirm)
		fail(`action "${action}" requires confirm: true`, 'ENVIRONMENT_CONFIRMATION_REQUIRED');
	if (payload.openTaskCenter !== undefined && typeof payload.openTaskCenter !== 'boolean')
		fail('openTaskCenter must be a boolean', 'INVALID_ENVIRONMENT_ARGUMENT');
	params.openTaskCenter = payload.openTaskCenter === true;
	return params;
}

/** Complete, secret-free environment description for MCP clients. */
export function describeEnvironment(env: EnvironmentView) {
	const mode = environmentMode(env);
	return {
		environmentId: env.environmentId,
		revision: env.revision,
		displayName: env.displayName,
		engineId: env.engineId,
		mode,
		connectionKind: env.connectionKind,
		schedulerKind: env.schedulerKind,
		...(env.connectionKind === 'ssh'
			? {
					host: env.host,
					port: env.port,
					user: env.user,
					authentication: env.authentication,
					...(env.authentication === 'private-key' ? { privateKeyPath: env.privateKeyPath } : {})
				}
			: {}),
		...(env.connectionKind === 'wsl' ? { distribution: env.distribution, user: env.user } : {}),
		executable: env.executable,
		workingRoot: env.workingRoot,
		...(mode === 'slurm'
			? {
					partition: env.partition,
					account: env.account,
					qos: env.qos,
					timeLimit: env.timeLimit,
					slurmMemoryPolicy: env.slurmMemoryPolicy ?? 'input-request',
					submitCommandTemplate: env.submitCommandTemplate ?? ''
				}
			: {}),
		initialization: env.initialization,
		calculationTemplate: env.calculationTemplate ?? '',
		...(env.templateVariables?.length ? { templateVariables: env.templateVariables } : {}),
		...(env.siteId ? { siteId: env.siteId } : {}),
		check: env.check
			? {
					state: env.check.state,
					checkedAt: env.check.checkedAt,
					connection: env.check.connection,
					entry: env.check.entry,
					family: env.check.family,
					version: env.check.version.value
				}
			: null
	};
}

function describeSite(site: SiteProfileView) {
	return {
		siteId: site.siteId,
		displayName: site.displayName,
		connectionKind: site.connectionKind,
		schedulerKind: site.schedulerKind,
		host: site.host,
		port: site.port,
		user: site.user,
		workingRoot: site.workingRoot
	};
}

/**
 * Merge a patch onto a base environment and project it into a consistent shape
 * (mode-dependent fields, inferred SSH authentication, default display names)
 * so AI callers do not leave `authentication: "agent"` when supplying a password
 * or private key.
 */
export function mergeEnvironmentPatch(
	base: EnvironmentView,
	patch: EnvironmentPatch,
	secret?: EnvironmentSecretPayload
): EnvironmentView {
	const { mode, ...fields } = patch;
	const next: EnvironmentView = { ...base, ...fields };
	if (mode) {
		next.connectionKind = mode === 'slurm' ? 'ssh' : mode;
		next.schedulerKind = mode === 'slurm' ? 'slurm' : 'none';
	}
	if (next.connectionKind !== 'ssh') next.schedulerKind = 'none';
	if (next.connectionKind === 'ssh' && patch.authentication === undefined) {
		if (secret?.password !== undefined) {
			next.authentication = 'password';
		} else if (
			secret?.privateKeyPassphrase !== undefined ||
			(typeof patch.privateKeyPath === 'string' && patch.privateKeyPath.trim() !== '')
		) {
			next.authentication = 'private-key';
		}
	}
	const nextMode = environmentMode(next);
	if (nextMode !== 'slurm') {
		next.submitCommandTemplate = '';
		delete next.slurmMemoryPolicy;
	}
	if (patch.displayName === undefined && isDefaultEnvironmentDisplayName(base.displayName)) {
		next.displayName = defaultEnvironmentDisplayName(next.engineId, nextMode);
	}
	delete next.check;
	return next;
}

function assertSecretCompatibleWithDraft(draft: EnvironmentView, secret?: EnvironmentSecretPayload) {
	if (!secret) return;
	if (draft.connectionKind !== 'ssh') {
		fail('secret 仅适用于 SSH 或 SSH + Slurm 执行环境', 'INVALID_ENVIRONMENT_ARGUMENT');
	}
	if (draft.authentication === 'agent') {
		fail(
			'SSH 认证方式为 "agent" 时不支持传入 password 或 privateKeyPassphrase',
			'INVALID_ENVIRONMENT_ARGUMENT'
		);
	}
	if (draft.authentication === 'password' && secret.privateKeyPassphrase !== undefined) {
		fail(
			'SSH 认证方式为 "password" 时不能传入 privateKeyPassphrase',
			'INVALID_ENVIRONMENT_ARGUMENT'
		);
	}
	if (draft.authentication === 'private-key' && secret.password !== undefined) {
		fail(
			'SSH 认证方式为 "private-key" 时不能传入 password（请改传 privateKeyPassphrase）',
			'INVALID_ENVIRONMENT_ARGUMENT'
		);
	}
}

function assertDraftValid(draft: EnvironmentView, platform?: string, secret?: EnvironmentSecretPayload) {
	assertSecretCompatibleWithDraft(draft, secret);
	const issues = environmentDraftIssues(draft, platform);
	if (issues.length > 0) {
		throw Object.assign(
			new Error(`执行环境配置不完整或无效：${issues.map(issue => `${issue.field}: ${issue.message}`).join('；')}`),
			{ code: 'MCP_ENVIRONMENT_INVALID', issues }
		);
	}
}

function findEnvironment(center: TaskCenterView, environmentId: string): EnvironmentView {
	const found = center.environments.find(env => env.environmentId === environmentId);
	if (!found) {
		const available = center.environments.map(env => `${env.environmentId} (${env.displayName})`).join(', ') || '无';
		fail(`未找到计算环境 "${environmentId}"。当前环境：${available}。`, 'MCP_ENVIRONMENT_NOT_FOUND');
	}
	return found;
}

function assertRevision(env: EnvironmentView, expectedRevision?: number) {
	if (expectedRevision !== undefined && env.revision !== expectedRevision) {
		fail(
			`计算环境 "${env.displayName}" 当前 revision 为 ${env.revision}，与 expectedRevision=${expectedRevision} 不一致（可能已被用户修改），请先 get 后重试。`,
			'MCP_ENVIRONMENT_REVISION_CONFLICT'
		);
	}
}

/** Enter the Task Center as manager for mutating environment commands. */
async function withManager<T>(bridge: TaskSystemBridge, run: (center: TaskCenterView) => Promise<T>): Promise<T> {
	const entryId = `mcp-environment-${crypto.randomUUID()}`;
	let entered = false;
	try {
		let center = await bridge.request('center.enter', { entryId });
		entered = true;
		if (!center.library.libraryId || !center.library.path) {
			fail(
				'当前尚未关联任务中心存储目录，请先在任务中心关联任务库后再配置执行环境。',
				'MCP_TASK_LIBRARY_UNASSOCIATED'
			);
		}
		if (center.manager.access !== 'manager') {
			const acquired = await bridge.request('manager.acquire', { entryId });
			if (acquired.access !== 'manager') {
				fail(
					`当前窗口未取得任务库管理权（${acquired.reason || '由其他实例占用'}），无法修改执行环境。`,
					'MCP_TASK_MANAGER_REQUIRED'
				);
			}
			center = await bridge.request('center.read', {});
		}
		return await run(center);
	} finally {
		if (entered) await bridge.request('center.leave', { entryId }).catch(() => {});
	}
}

function resolveDraft(center: TaskCenterView, params: EnvironmentManageParams, platform?: string): EnvironmentView {
	const base = params.environmentId ? findEnvironment(center, params.environmentId) : newEnvironment(platform);
	if (params.environmentId) assertRevision(base, params.expectedRevision);
	return params.environment || params.secret
		? mergeEnvironmentPatch(base, params.environment ?? {}, params.secret)
		: { ...base };
}

function summarizeBrowse(result: EnvironmentBrowseResult | null) {
	if (!result) return { cancelled: true as const };
	const entries = result.entries.slice(0, MAX_BROWSE_ENTRIES);
	return {
		domain: result.domain,
		path: result.path,
		...(result.parentPath ? { parentPath: result.parentPath } : {}),
		...(result.selected ? { selected: result.selected } : {}),
		entryCount: result.entries.length,
		truncated: result.entries.length > entries.length,
		entries
	};
}

export async function executeEnvironmentManageAction(options: {
	bridge: TaskSystemBridge;
	params: EnvironmentManageParams;
	platform?: string;
}) {
	const { bridge, params, platform } = options;
	const { action } = params;

	if (action === 'list') {
		const center = await bridge.request('center.read', {});
		return {
			action,
			library: {
				associated: Boolean(center.library.libraryId && center.library.path),
				libraryId: center.library.libraryId,
				path: center.library.path
			},
			managerAccess: center.manager.access,
			environmentCount: center.environments.length,
			environments: center.environments.map(describeEnvironment),
			sites: (center.siteProfiles ?? []).filter(site => !site.deleted).map(describeSite)
		};
	}

	if (action === 'get') {
		const center = await bridge.request('center.read', {});
		return { action, environment: describeEnvironment(findEnvironment(center, params.environmentId!)) };
	}

	if (action === 'create' || action === 'update') {
		return withManager(bridge, async center => {
			const draft =
				action === 'create'
					? mergeEnvironmentPatch(newEnvironment(platform), params.environment!, params.secret)
					: resolveDraft(center, params, platform);
			if (action === 'create') {
				draft.environmentId = '';
				draft.revision = 0;
			}
			assertDraftValid(draft, platform, params.secret);
			const saved = await bridge.request('environment.save', {
				environment: draft,
				...(params.secret ? { secret: params.secret } : {})
			});
			return {
				action,
				saved: true,
				...(params.secret ? { secretStored: params.secret.remember === true } : {}),
				environment: describeEnvironment(saved),
				nextStep: saved.check?.state === 'passed' ? undefined : '建议调用 action="check" 检测连接与软件版本。'
			};
		});
	}

	if (action === 'delete') {
		return withManager(bridge, async center => {
			const env = findEnvironment(center, params.environmentId!);
			assertRevision(env, params.expectedRevision);
			await bridge.request('environment.delete', { environmentId: env.environmentId });
			return { action, deleted: true, environmentId: env.environmentId, displayName: env.displayName };
		});
	}

	if (action === 'check') {
		return withManager(bridge, async center => {
			const draft = resolveDraft(center, params, platform);
			assertDraftValid(draft, platform, params.secret);
			const result = await bridge.request('environment.check', {
				environment: draft,
				...(params.secret ? { secret: params.secret } : {})
			});
			let persisted: EnvironmentView | null = null;
			// A saved, unmodified environment keeps the verified check and any supplied secret like the dialog's save does.
			if (result.check && !result.hostKey && params.environmentId && !params.environment) {
				persisted = await bridge
					.request('environment.save', {
						environment: draft,
						...(params.secret ? { secret: params.secret } : {})
					})
					.catch(() => null);
			}
			return {
				action,
				message: result.message,
				...(result.details ? { details: result.details } : {}),
				...(result.hostKey
					? {
							hostKey: result.hostKey,
							nextStep:
								result.hostKey.state === 'changed'
									? '主机密钥已改变，连接被拒绝；请让用户核实服务器后在系统 known_hosts 中处理。'
									: '请向用户展示指纹并在其同意后调用 action="trust-host-key"（confirm: true），然后重新 check。'
						}
					: {}),
				check: result.check
					? {
							state: result.check.state,
							checkedAt: result.check.checkedAt,
							connection: result.check.connection,
							entry: result.check.entry,
							family: result.check.family,
							version: result.check.version.value,
							execution: result.check.execution
						}
					: null,
				checkPersisted: Boolean(persisted),
				...(params.secret && persisted ? { secretStored: params.secret.remember === true } : {}),
				...(persisted ? { environment: describeEnvironment(persisted) } : {})
			};
		});
	}

	if (action === 'trust-host-key') {
		return withManager(bridge, async () => {
			await bridge.request('environment.trust-host-key', {
				challengeId: params.challengeId!,
				fingerprint: params.fingerprint!
			});
			return { action, trusted: true, fingerprint: params.fingerprint, nextStep: '请重新调用 action="check"。' };
		});
	}

	if (action === 'browse') {
		// Read-only exploration: no task-library manager rights are required.
		// Local targets (and private keys) open a native picker for the user.
		const center = await bridge.request('center.read', {});
		const draft = resolveDraft(center, params, platform);
		assertSecretCompatibleWithDraft(draft, params.secret);
		const result = await bridge.request('environment.browse', {
			environment: draft,
			...(params.secret ? { secret: params.secret } : {}),
			purpose: params.browsePurpose!,
			...(params.browsePath ? { path: params.browsePath } : {}),
			mode: params.browsePurpose === 'working-root' ? 'directory' : 'file'
		});
		return { action, purpose: params.browsePurpose, ...summarizeBrowse(result) };
	}

	return fail(`Unsupported environment action: ${String(action)}`, 'INVALID_ENVIRONMENT_MANAGE_ACTION');
}
