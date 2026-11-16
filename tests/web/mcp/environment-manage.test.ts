import { describe, expect, it } from 'vitest';
import type {
	EnvironmentView,
	TaskCenterView,
	TaskSystemBridge
} from '../../../src/task-system/application-contracts';
import {
	describeEnvironment,
	executeEnvironmentManageAction,
	mergeEnvironmentPatch,
	normalizeEnvironmentManageParams
} from '../../../src/web/mcp/environment-manage';
import { createWorkspaceRegistry } from '../../../src/modeling/workspace-registry';
import { createMcpFrontendDispatcher } from '../../../src/web/mcp/useMcpCollaborationBridge';
import {
	environmentDraftIssues,
	newEnvironment
} from '../../../src/web/task-system/environment-draft';

const sshEnv: EnvironmentView = {
	...newEnvironment('darwin'),
	environmentId: 'env-ssh',
	revision: 2,
	displayName: 'ORCA · SSH服务器',
	engineId: 'orca',
	connectionKind: 'ssh',
	host: 'hpc.example.org',
	user: 'alice',
	executable: '/opt/orca/orca',
	workingRoot: '/home/alice/jobs',
	check: {
		state: 'passed',
		fingerprint: 'fp',
		checkedAt: '2026-11-01T00:00:00Z',
		connection: 'passed',
		entry: 'passed',
		family: { state: 'passed', engineId: 'orca' },
		version: { state: 'known', value: '6.0.1' },
		execution: 'not-tested',
		evidenceKind: 'command-output'
	}
};

interface Call { command: string; input: any }

function center(overrides: Partial<TaskCenterView> = {}): TaskCenterView {
	return {
		manager: { access: 'manager', epoch: 1 },
		library: { libraryId: 'lib', path: '/lib', migrating: false, recycledCount: 0, recycledBytes: 0 },
		tasks: [],
		groups: [],
		environments: [sshEnv],
		monitoring: { localIntervalSeconds: 5, remoteIntervalSeconds: 30, backgroundIntervalSeconds: 60, automatic: true },
		siteProfiles: [],
		...overrides
	};
}

function mockBridge(handlers: Record<string, (input: any) => unknown> = {}, view: TaskCenterView = center()) {
	const calls: Call[] = [];
	const bridge = {
		request: async (command: string, input: any) => {
			calls.push({ command, input });
			if (handlers[command]) return handlers[command](input);
			if (['center.enter', 'center.read'].includes(command)) return view;
			if (command === 'center.leave') return undefined;
			if (command === 'manager.acquire') return { access: 'manager', epoch: 2 };
			if (command === 'environment.save') return { ...input.environment, environmentId: input.environment.environmentId || 'env-new', revision: (input.environment.revision || 0) + 1 };
			return undefined;
		},
		subscribe: () => () => {}
	} as unknown as TaskSystemBridge;
	return { bridge, calls };
}

const run = (bridge: TaskSystemBridge, payload: Record<string, unknown>) =>
	executeEnvironmentManageAction({ bridge, params: normalizeEnvironmentManageParams(payload), platform: 'darwin' });

describe('MCP environment management (frontend executor)', () => {
	it('lists and gets environments without leaking credentials', async () => {
		const { bridge } = mockBridge();
		const listed: any = await run(bridge, { action: 'list' });
		expect(listed.environmentCount).toBe(1);
		expect(listed.library.associated).toBe(true);
		expect(listed.environments[0]).toMatchObject({ environmentId: 'env-ssh', mode: 'ssh', host: 'hpc.example.org', check: { state: 'passed', version: '6.0.1' } });
		const got: any = await run(bridge, { action: 'get', environmentId: 'env-ssh' });
		expect(got.environment.executable).toBe('/opt/orca/orca');
		expect(JSON.stringify(got)).not.toMatch(/password|passphrase/i);
		await expect(run(bridge, { action: 'get', environmentId: 'missing' })).rejects.toMatchObject({ code: 'MCP_ENVIRONMENT_NOT_FOUND' });
	});

	it('creates an SSH + Slurm environment with defaults and passes secrets only to environment.save', async () => {
		const { bridge, calls } = mockBridge();
		const created: any = await run(bridge, {
			action: 'create',
			environment: { mode: 'slurm', engineId: 'gaussian', host: 'hpc', user: 'bob', executable: '/apps/g16/g16', workingRoot: '/scratch/bob', partition: 'cpu', timeLimit: '24:00:00' },
			secret: { password: 'S3cret!', remember: true }
		});
		const save = calls.find(c => c.command === 'environment.save')!;
		expect(save.input.environment).toMatchObject({ environmentId: '', revision: 0, connectionKind: 'ssh', schedulerKind: 'slurm', port: 22, authentication: 'password', displayName: 'Gaussian · SSH + Slurm' });
		expect(save.input.secret).toEqual({ password: 'S3cret!', remember: true });
		expect(created.saved).toBe(true);
		expect(created.secretStored).toBe(true);
		expect(created.environment.mode).toBe('slurm');
		expect(created.environment.authentication).toBe('password');
		expect(JSON.stringify(created)).not.toContain('S3cret!');
		expect(calls.at(-1)!.command).toBe('center.leave');

		const keyEnv: any = await run(bridge, {
			action: 'create',
			environment: { mode: 'ssh', engineId: 'orca', host: 'hpc', user: 'bob', executable: '/opt/orca/orca', workingRoot: '/scratch/bob', privateKeyPath: '/Users/bob/.ssh/id_ed25519' },
			secret: { privateKeyPassphrase: 'pass', remember: false }
		});
		expect(keyEnv.environment.authentication).toBe('private-key');
		expect(keyEnv.environment.privateKeyPath).toBe('/Users/bob/.ssh/id_ed25519');
		await expect(run(bridge, { action: 'create', environment: { mode: 'ssh', engineId: 'orca', host: 'hpc', user: 'bob', executable: '/opt/orca/orca', workingRoot: '/scratch/bob', authentication: 'agent' }, secret: { password: 'x' } }))
			.rejects.toMatchObject({ code: 'INVALID_ENVIRONMENT_ARGUMENT' });
		await expect(run(bridge, { action: 'create', environment: { mode: 'ssh', engineId: 'orca', host: 'hpc', user: 'bob', executable: '/opt/orca/orca', workingRoot: '/scratch/bob', authentication: 'private-key', privateKeyPath: '/Users/bob/.ssh/id_ed25519' }, secret: { password: 'x' } }))
			.rejects.toMatchObject({ code: 'INVALID_ENVIRONMENT_ARGUMENT' });
	});

	it('rejects invalid drafts with field-level issues and refuses non-SSH environments on macOS', async () => {
		const { bridge, calls } = mockBridge();
		await expect(run(bridge, { action: 'create', environment: { mode: 'ssh', engineId: 'orca', host: 'h', user: 'u', executable: 'orca', workingRoot: '/w' } }))
			.rejects.toMatchObject({ code: 'MCP_ENVIRONMENT_INVALID' });
		await expect(run(bridge, { action: 'create', environment: { mode: 'local', executable: 'C:\\g16\\g16.exe', workingRoot: 'C:\\jobs' } }))
			.rejects.toThrow(/仅支持 SSH/);
		expect(calls.some(c => c.command === 'environment.save')).toBe(false);
		expect(environmentDraftIssues({ ...newEnvironment('win32'), connectionKind: 'local', executable: 'C:\\g16\\g16.exe', workingRoot: 'C:\\jobs' }, 'win32')).toEqual([]);
	});

	it('updates by merging onto the saved environment and guards revisions', async () => {
		const { bridge, calls } = mockBridge();
		const updated: any = await run(bridge, { action: 'update', environmentId: 'env-ssh', expectedRevision: 2, environment: { mode: 'slurm', partition: 'gpu' } });
		const save = calls.find(c => c.command === 'environment.save')!;
		expect(save.input.environment).toMatchObject({ environmentId: 'env-ssh', revision: 2, host: 'hpc.example.org', schedulerKind: 'slurm', partition: 'gpu', displayName: 'ORCA · SSH + Slurm' });
		expect(save.input.environment.check).toBeUndefined();
		expect(updated.environment.revision).toBe(3);
		await expect(run(bridge, { action: 'update', environmentId: 'env-ssh', expectedRevision: 1, environment: { user: 'x' } }))
			.rejects.toMatchObject({ code: 'MCP_ENVIRONMENT_REVISION_CONFLICT' });
	});

	it('requires an associated task library and manager rights for mutations', async () => {
		const unassociated = mockBridge({}, center({ library: { libraryId: null, path: null, migrating: false, recycledCount: 0, recycledBytes: null } }));
		await expect(run(unassociated.bridge, { action: 'delete', environmentId: 'env-ssh', confirm: true })).rejects.toMatchObject({ code: 'MCP_TASK_LIBRARY_UNASSOCIATED' });
		expect(unassociated.calls.at(-1)!.command).toBe('center.leave');

		const readonly = mockBridge({ 'manager.acquire': () => ({ access: 'readonly', epoch: null, reason: '另一窗口持有' }) }, center({ manager: { access: 'readonly', epoch: null } }));
		await expect(run(readonly.bridge, { action: 'update', environmentId: 'env-ssh', environment: { user: 'x' } })).rejects.toThrow(/另一窗口持有/);
	});

	it('deletes only with confirm and reports the deleted environment', async () => {
		expect(() => normalizeEnvironmentManageParams({ action: 'delete', environmentId: 'env-ssh' })).toThrow(/confirm/);
		const { bridge, calls } = mockBridge();
		const result: any = await run(bridge, { action: 'delete', environmentId: 'env-ssh', confirm: true });
		expect(result).toMatchObject({ deleted: true, environmentId: 'env-ssh' });
		expect(calls.find(c => c.command === 'environment.delete')!.input).toEqual({ environmentId: 'env-ssh' });
	});

	it('checks saved environments, persists passing results, and surfaces host-key challenges', async () => {
		const checkView = { ...sshEnv.check!, checkedAt: '2026-11-11T00:00:00Z' };
		const passing = mockBridge({ 'environment.check': () => ({ message: '已识别软件版本：6.0.1', check: checkView }) });
		const ok: any = await run(passing.bridge, { action: 'check', environmentId: 'env-ssh', secret: { password: 'pw', remember: true } });
		expect(ok.check).toMatchObject({ state: 'passed', version: '6.0.1' });
		expect(ok.checkPersisted).toBe(true);
		expect(ok.secretStored).toBe(true);
		const checkSaves = passing.calls.filter(c => c.command === 'environment.save');
		expect(checkSaves).toHaveLength(1);
		expect(checkSaves[0].input.secret).toEqual({ password: 'pw', remember: true });
		expect(checkSaves[0].input.environment.authentication).toBe('password');

		const challenge = { challengeId: 'c-1', host: 'hpc.example.org', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:xyz', state: 'unknown' };
		const hostKey = mockBridge({ 'environment.check': () => ({ message: '请核对主机指纹后显式信任', hostKey: challenge }) });
		const pending: any = await run(hostKey.bridge, { action: 'check', environmentId: 'env-ssh', secret: { password: 'pw' } });
		expect(pending.hostKey).toEqual(challenge);
		expect(pending.nextStep).toMatch(/trust-host-key/);
		expect(pending.checkPersisted).toBe(false);
		expect(hostKey.calls.find(c => c.command === 'environment.check')!.input.secret).toEqual({ password: 'pw', remember: false });

		const trusted: any = await run(hostKey.bridge, { action: 'trust-host-key', challengeId: 'c-1', fingerprint: 'SHA256:xyz', confirm: true });
		expect(trusted.trusted).toBe(true);
		expect(hostKey.calls.find(c => c.command === 'environment.trust-host-key')!.input).toEqual({ challengeId: 'c-1', fingerprint: 'SHA256:xyz' });
	});

	it('browses remote directories with truncation and treats a null result as cancelled', async () => {
		const entries = Array.from({ length: 600 }, (_, i) => ({ name: `f${i}`, kind: 'file' as const }));
		const { bridge, calls } = mockBridge({ 'environment.browse': () => ({ domain: 'ssh', path: '/opt', parentPath: '/', entries }) });
		const result: any = await run(bridge, { action: 'browse', environmentId: 'env-ssh', browsePurpose: 'working-root', browsePath: '/opt' });
		expect(result).toMatchObject({ domain: 'ssh', path: '/opt', entryCount: 600, truncated: true });
		expect(result.entries).toHaveLength(500);
		expect(calls.find(c => c.command === 'environment.browse')!.input).toMatchObject({ purpose: 'working-root', path: '/opt', mode: 'directory' });
		expect(calls.some(c => c.command === 'center.enter')).toBe(false);

		const cancelled = mockBridge({ 'environment.browse': () => null });
		expect(await run(cancelled.bridge, { action: 'browse', environment: { mode: 'ssh', host: 'h', user: 'u' }, browsePurpose: 'private-key' })).toMatchObject({ cancelled: true });
	});

	it('merges patches like the dialog: mode projection, slurm-only fields, custom names preserved', () => {
		const slurm = mergeEnvironmentPatch(sshEnv, { mode: 'slurm', slurmMemoryPolicy: 'site-managed', submitCommandTemplate: 'sbatch {script}' });
		expect(slurm.schedulerKind).toBe('slurm');
		const back = mergeEnvironmentPatch({ ...slurm, displayName: 'My cluster' }, { mode: 'ssh' });
		expect(back).toMatchObject({ schedulerKind: 'none', submitCommandTemplate: '', displayName: 'My cluster' });
		expect(back.slurmMemoryPolicy).toBeUndefined();
		expect(describeEnvironment(back)).not.toHaveProperty('partition');
	});

	it('validates renderer-side payloads defensively', () => {
		expect(() => normalizeEnvironmentManageParams({ action: 'drop' })).toThrow(/action must be one of/);
		expect(() => normalizeEnvironmentManageParams({ action: 'create', environment: { bogus: 1 } })).toThrow(/Unknown environment field/);
		expect(() => normalizeEnvironmentManageParams({ action: 'create', environment: {}, secret: { password: 'a', privateKeyPassphrase: 'b' } })).toThrow(/exactly one/);
		expect(() => normalizeEnvironmentManageParams({ action: 'browse', environmentId: 'e', browsePurpose: 'x' })).toThrow(/browsePurpose/);
		expect(normalizeEnvironmentManageParams({ action: 'list', openTaskCenter: true })).toMatchObject({ action: 'list', openTaskCenter: true, confirm: false });
	});

	it('routes frontend.environmentManage through the dispatcher and optionally opens the Task Center', async () => {
		const { bridge, calls } = mockBridge();
		let taskCenterOpen = false;
		const dispatcher = createMcpFrontendDispatcher({
			getRegistry: () => createWorkspaceRegistry(),
			isTaskCenterOpen: () => taskCenterOpen,
			getCallbacks: () => ({
				getTaskSystemBridge: () => bridge,
				setTaskCenterOpen: open => { taskCenterOpen = open; }
			})
		});
		const listed = await dispatcher.handleRequest({ requestId: 'e1', action: 'frontend.environmentManage', payload: { action: 'list', openTaskCenter: true } });
		expect(listed.ok).toBe(true);
		expect(taskCenterOpen).toBe(false);
		const updated = await dispatcher.handleRequest({ requestId: 'e2', action: 'frontend.environmentManage', payload: { action: 'update', environmentId: 'env-ssh', environment: { user: 'carol' }, openTaskCenter: true } });
		expect(updated.ok).toBe(true);
		expect((updated.result as any).environment.user).toBe('carol');
		expect((updated.result as any).workbench).toBeDefined();
		expect(taskCenterOpen).toBe(true);
		expect(calls.some(c => c.command === 'environment.save')).toBe(true);
		const rejected = await dispatcher.handleRequest({ requestId: 'e3', action: 'frontend.environmentManage', payload: { action: 'delete', environmentId: 'env-ssh' } });
		expect(rejected.ok).toBe(false);
		expect(rejected.error?.code).toBe('ENVIRONMENT_CONFIRMATION_REQUIRED');
	});
});
