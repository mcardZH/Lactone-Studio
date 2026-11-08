import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeEnvironment } = require('../../../desktop/task-system/environments.cjs');
const {
  sanitizeSiteProfile,
  flattenEnvironmentSite
} = require('../../../desktop/task-system/environment-profiles.cjs');

function makeSshEnv(overrides = {}) {
  return {
    environmentId: 'env-ssh-1',
    revision: 1,
    displayName: 'Gaussian · SSH服务器',
    engineId: 'gaussian',
    connectionKind: 'ssh',
    schedulerKind: 'none',
    host: 'cluster.example.org',
    port: 22,
    user: 'researcher',
    distribution: '',
    executable: '/opt/gaussian/g16/g16',
    workingRoot: '/home/researcher/es-tasks',
    scratchRoot: '',
    partition: '',
    account: '',
    qos: '',
    timeLimit: '',
    initialization: '',
    scriptTemplate: '',
    calculationTemplate: '',
    submitCommandTemplate: '',
    authentication: 'agent',
    privateKeyPath: '',
    ...overrides
  };
}

test('sanitizeEnvironment on darwin allows ssh/slurm with POSIX privateKeyPath and rejects local/wsl or non-POSIX privateKeyPath', () => {
  // 1. SSH with agent authentication on darwin
  const sshAgent = sanitizeEnvironment(makeSshEnv(), { platform: 'darwin' });
  assert.equal(sshAgent.connectionKind, 'ssh');
  assert.equal(sshAgent.schedulerKind, 'none');

  // 2. SSH + Slurm with POSIX private-key on darwin
  const sshKey = sanitizeEnvironment(
    makeSshEnv({
      schedulerKind: 'slurm',
      authentication: 'private-key',
      privateKeyPath: '/Users/researcher/.ssh/id_ed25519'
    }),
    { platform: 'darwin' }
  );
  assert.equal(sshKey.authentication, 'private-key');
  assert.equal(sshKey.privateKeyPath, '/Users/researcher/.ssh/id_ed25519');

  // 3. Rejects Windows drive path for privateKeyPath on darwin
  assert.throws(
    () =>
      sanitizeEnvironment(
        makeSshEnv({
          authentication: 'private-key',
          privateKeyPath: 'C:\\Users\\researcher\\.ssh\\id_ed25519'
        }),
        { platform: 'darwin' }
      ),
    (err) => err && err.code === 'PRIVATE_KEY_LOCAL_PATH_REQUIRED'
  );

  // 4. Rejects relative privateKeyPath on darwin
  assert.throws(
    () =>
      sanitizeEnvironment(
        makeSshEnv({
          authentication: 'private-key',
          privateKeyPath: '.ssh/id_ed25519'
        }),
        { platform: 'darwin' }
      ),
    (err) => err && err.code === 'PRIVATE_KEY_LOCAL_PATH_REQUIRED'
  );

  // 5. Rejects local connectionKind on darwin
  assert.throws(
    () =>
      sanitizeEnvironment(
        makeSshEnv({
          connectionKind: 'local',
          executable: 'C:\\G16W\\g16.exe',
          workingRoot: 'D:\\ES-Tasks'
        }),
        { platform: 'darwin' }
      ),
    (err) => err && err.code === 'ENVIRONMENT_INVALID'
  );

  // 6. Rejects wsl connectionKind on darwin
  assert.throws(
    () =>
      sanitizeEnvironment(
        makeSshEnv({
          connectionKind: 'wsl',
          distribution: 'Ubuntu-22.04',
          user: 'researcher'
        }),
        { platform: 'darwin' }
      ),
    (err) => err && err.code === 'ENVIRONMENT_INVALID'
  );
});

test('sanitizeEnvironment on win32 preserves local, wsl, and ssh with Windows privateKeyPath', () => {
  const winLocal = sanitizeEnvironment(
    makeSshEnv({
      connectionKind: 'local',
      host: '',
      user: '',
      executable: 'C:\\G16W\\g16.exe',
      workingRoot: 'D:\\ES-Tasks'
    }),
    { platform: 'win32' }
  );
  assert.equal(winLocal.connectionKind, 'local');

  const winWsl = sanitizeEnvironment(
    makeSshEnv({
      connectionKind: 'wsl',
      host: '',
      distribution: 'Ubuntu-22.04',
      user: 'researcher'
    }),
    { platform: 'win32' }
  );
  assert.equal(winWsl.connectionKind, 'wsl');

  const winSshKey = sanitizeEnvironment(
    makeSshEnv({
      authentication: 'private-key',
      privateKeyPath: 'C:\\Users\\researcher\\.ssh\\id_ed25519'
    }),
    { platform: 'win32' }
  );
  assert.equal(winSshKey.privateKeyPath, 'C:\\Users\\researcher\\.ssh\\id_ed25519');

  assert.throws(
    () =>
      sanitizeEnvironment(
        makeSshEnv({
          authentication: 'private-key',
          privateKeyPath: 'relative\\id_ed25519'
        }),
        { platform: 'win32' }
      ),
    (err) => err && err.code === 'PRIVATE_KEY_LOCAL_PATH_REQUIRED'
  );
});

test('sanitizeSiteProfile and flattenEnvironmentSite enforce ssh-only on darwin and preserve local/wsl/ssh on win32', () => {
  const baseSite = {
    siteId: 'site-1',
    revision: 1,
    displayName: 'Cluster A',
    connectionKind: 'ssh',
    host: 'cluster.example.org',
    port: 22,
    user: 'researcher',
    distribution: '',
    workingRoot: '/home/researcher/es-tasks',
    schedulerKind: 'slurm',
    partition: 'cpu',
    account: '',
    qos: '',
    timeLimit: '',
    authentication: 'private-key',
    privateKeyPath: '/Users/researcher/.ssh/id_ed25519'
  };

  const darwinSite = sanitizeSiteProfile(baseSite, { platform: 'darwin' });
  assert.equal(darwinSite.connectionKind, 'ssh');

  const flattened = flattenEnvironmentSite(makeSshEnv(), baseSite, { platform: 'darwin' });
  assert.equal(flattened.siteId, 'site-1');
  assert.equal(flattened.schedulerKind, 'slurm');

  assert.throws(
    () =>
      sanitizeSiteProfile(
        {
          ...baseSite,
          connectionKind: 'local',
          schedulerKind: 'none',
          workingRoot: 'D:\\ES-Tasks'
        },
        { platform: 'darwin' }
      ),
    (err) => err && err.code === 'SITE_PROFILE_INVALID'
  );

  assert.throws(
    () =>
      sanitizeSiteProfile(
        {
          ...baseSite,
          connectionKind: 'wsl',
          schedulerKind: 'none',
          distribution: 'Ubuntu-22.04'
        },
        { platform: 'darwin' }
      ),
    (err) => err && err.code === 'SITE_PROFILE_INVALID'
  );

  const winLocalSite = sanitizeSiteProfile(
    {
      ...baseSite,
      connectionKind: 'local',
      schedulerKind: 'none',
      workingRoot: 'D:\\ES-Tasks'
    },
    { platform: 'win32' }
  );
  assert.equal(winLocalSite.connectionKind, 'local');
});
