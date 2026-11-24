import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createTerminalHost,
  clientBootstrap,
  resolvePosixShell,
  resolvePythonExecutable
} = require('../../desktop/mcp-terminal.cjs');

describe('Cross-platform AgentTerminal without node-pty dependency', () => {
  const tempDirs = [];
  const terminalHosts = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lactone-term-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (terminalHosts.length > 0) {
      const h = terminalHosts.pop();
      await h.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds cross-platform clientBootstrap configs for zsh, bash, and PowerShell', () => {
    const dir = makeTempDir();
    const conn = {
      command: '/path/to/electron',
      args: ['/path/to/stdio.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', ES_MCP_DISCOVERY_DIR: '/tmp/disc', ES_MCP_INSTANCE_ID: randomUUID(), ES_MCP_WINDOW_ID: randomUUID() }
    };

    const zshBoot = clientBootstrap('codex', conn, dir, { platform: 'darwin', shell: '/bin/zsh', env: {} });
    assert.equal(zshBoot.shell, '/bin/zsh');
    assert.deepEqual(zshBoot.args, ['-i']);
    assert.ok(fs.existsSync(path.join(zshBoot.extraEnv.ZDOTDIR, '.zshrc')));
    const helperContent = fs.readFileSync(zshBoot.files.find(f => f.endsWith('ls-init.sh')), 'utf8');
    assert.ok(helperContent.includes('es-codex()'));
    assert.ok(helperContent.includes('es-claude()'));
    assert.ok(helperContent.includes('es-dsh()'));
    assert.ok(helperContent.endsWith('es-codex\n'));
    for (const d of zshBoot.cleanupDirs) fs.rmSync(d, { recursive: true, force: true });

    const bashBoot = clientBootstrap('shell', null, dir, { platform: 'linux', shell: '/bin/bash', env: {} });
    assert.equal(bashBoot.shell, '/bin/bash');
    assert.equal(bashBoot.args[0], '--rcfile');
    assert.equal(bashBoot.args[2], '-i');
    for (const d of bashBoot.cleanupDirs) fs.rmSync(d, { recursive: true, force: true });

    const winBoot = clientBootstrap('claude', conn, dir, { platform: 'win32' });
    assert.equal(winBoot.args[0], '-NoLogo');
    assert.equal(winBoot.files.length, 2);
    assert.throws(() => clientBootstrap('codex', null, dir, { platform: 'darwin' }), /MCP 连接尚未就绪/);

    assert.equal(resolvePosixShell({ platform: 'darwin', env: { SHELL: '/nonexistent/shell' } }), fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');

    // Verify packaged <resourcesPath>/chemistry/python/bin/python3 resolution and null fallback
    const fakeResources = path.join(dir, 'AppResources');
    const fakeBundledPy = path.join(fakeResources, 'chemistry', 'python', 'bin', 'python3');
    fs.mkdirSync(path.dirname(fakeBundledPy), { recursive: true });
    fs.writeFileSync(fakeBundledPy, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(
      resolvePythonExecutable({ platform: 'darwin', arch: 'arm64', env: {}, resourcesPath: fakeResources, devRoot: dir, systemCandidates: [] }),
      fakeBundledPy
    );
    const fakeBrewPy = path.join(dir, 'brew-python3');
    const fakeStubUsrPy = path.join(dir, 'usr-python3');
    fs.writeFileSync(fakeBrewPy, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(fakeStubUsrPy, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(
      resolvePythonExecutable({ platform: 'darwin', arch: 'arm64', env: {}, resourcesPath: dir, devRoot: dir, systemCandidates: [fakeBrewPy, fakeStubUsrPy] }),
      fakeBrewPy
    );
    assert.equal(
      resolvePythonExecutable({
        platform: 'linux',
        arch: 'x64',
        env: {},
        resourcesPath: path.join(dir, 'missing-resources'),
        devRoot: dir,
        systemCandidates: [path.join(dir, 'missing-py')]
      }),
      null
    );
    assert.equal(resolvePythonExecutable({ platform: 'win32' }), null);
    if (process.platform !== 'win32') {
      assert.ok(resolvePythonExecutable({ platform: process.platform, env: {} }));
    }
  });

  it('spawns real interactive POSIX PTY via Python stdlib helper, handles I/O + dynamic resize, and cleans up on exit', async () => {
    if (process.platform === 'win32') return;

    const dir = makeTempDir();
    const host = createTerminalHost({ userDataPath: dir });
    terminalHosts.push(host);

    const sessionId = randomUUID();
    let buffer = '';
    let exitEvent = null;
    let exitResolve;
    const exitPromise = new Promise(resolve => { exitResolve = resolve; });

    const started = await host.start(
      1,
      { id: sessionId, cols: 80, rows: 24, client: 'shell' },
      {
        connectionConfig: {
          command: process.execPath,
          args: ['/fake/stdio.cjs'],
          env: { ELECTRON_RUN_AS_NODE: '1', ES_MCP_INSTANCE_ID: 'inst-1', ES_MCP_WINDOW_ID: 'win-1' }
        },
        projectIndexPath: path.join(dir, 'proj.es'),
        publish(ev) {
          if (ev.type === 'data') buffer += ev.data;
          if (ev.type === 'exit') { exitEvent = ev; exitResolve(ev); }
        }
      }
    );
    assert.equal(started.id, sessionId);
    assert.ok(Number.isInteger(started.pid) && started.pid > 0);

    // Resize PTY and query both env var & real TTY stty size inside the PTY
    host.resize(1, sessionId, 102, 33);
    host.write(1, sessionId, 'echo "ENV=$ES_MCP_INSTANCE_ID"; stty size; exit\n');

    let exitTimer;
    try {
      await Promise.race([
        exitPromise,
        new Promise((_, reject) => {
          exitTimer = setTimeout(() => reject(new Error(`Terminal exit timeout; output so far: ${buffer}`)), 8000);
        })
      ]);
    } finally {
      clearTimeout(exitTimer);
    }

    assert.ok(buffer.includes('ENV=inst-1'), `Expected ES_MCP_INSTANCE_ID output in PTY buffer, got: ${buffer}`);
    assert.ok(buffer.includes('33 102'), `Expected updated PTY winsize "33 102", got: ${buffer}`);
    assert.equal(exitEvent.exitCode, 0);

    // Verify per-session temp directory cleaned up after exit
    const terminalTempRoot = path.join(dir, 'mcp-terminal');
    const remaining = fs.existsSync(terminalTempRoot) ? fs.readdirSync(terminalTempRoot) : [];
    assert.deepEqual(remaining, []);
  });

  it('supports piped fallback worker execution when no Python helper or node-pty is provided', async () => {
    if (process.platform === 'win32') return;

    const workerPath = path.resolve(import.meta.dirname, '../../desktop/mcp-terminal-worker.cjs');
    const worker = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });

    const events = [];
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Piped worker timeout')), 5000);
      worker.on('message', msg => {
        events.push(msg);
        if (msg.type === 'started') {
          worker.send({ type: 'write', data: 'echo PIPE_OK\recho NEXT\nexit\n' });
        } else if (msg.type === 'exit') {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.type === 'failure') {
          clearTimeout(timer);
          reject(new Error(msg.error));
        }
      });
    });

    worker.send({
      type: 'start',
      shell: '/bin/sh',
      args: [],
      pythonExecutable: null,
      options: { cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env }
    });

    const exitMsg = await done;
    assert.equal(exitMsg.exitCode, 0);
    const allText = events.filter(e => e.type === 'data').map(e => e.data).join('');
    assert.ok(allText.includes('PIPE_OK'));
    assert.ok(allText.includes('NEXT'));
  });

  it('falls back to piped shell when pre-ready Python helper exits non-zero (e.g. macOS xcrun stub)', async () => {
    if (process.platform === 'win32') return;

    const dir = makeTempDir();
    const stubPython = path.join(dir, 'xcrun-stub-python3');
    fs.writeFileSync(stubPython, '#!/bin/sh\necho "xcode-select: note: no developer tools were found" >&2\nexit 1\n', { mode: 0o755 });

    const host = createTerminalHost({
      userDataPath: dir,
      resolvePython: () => stubPython
    });
    terminalHosts.push(host);

    const sessionId = randomUUID();
    let buffer = '';
    let exitEvent = null;
    let exitResolve;
    const exitPromise = new Promise(resolve => { exitResolve = resolve; });

    const started = await host.start(
      7,
      { id: sessionId, cols: 80, rows: 24, client: 'shell' },
      {
        connectionConfig: {
          command: process.execPath,
          args: ['/fake/stdio.cjs'],
          env: { ELECTRON_RUN_AS_NODE: '1', ES_MCP_INSTANCE_ID: 'inst-fb', ES_MCP_WINDOW_ID: 'win-fb' }
        },
        projectIndexPath: path.join(dir, 'proj.es'),
        publish(ev) {
          if (ev.type === 'data') buffer += ev.data;
          if (ev.type === 'exit') { exitEvent = ev; exitResolve(ev); }
        }
      }
    );
    assert.equal(started.id, sessionId);
    assert.ok(Number.isInteger(started.pid) && started.pid > 0);

    host.write(7, sessionId, 'echo "XC_FALLBACK_OK=$ES_MCP_INSTANCE_ID"\nexit\n');
    let fallbackTimer;
    try {
      await Promise.race([
        exitPromise,
        new Promise((_, reject) => {
          fallbackTimer = setTimeout(() => reject(new Error(`Fallback exit timeout; buffer=${buffer}`)), 8000);
        })
      ]);
    } finally {
      clearTimeout(fallbackTimer);
    }

    assert.equal(exitEvent.exitCode, 0);
    assert.ok(buffer.includes('XC_FALLBACK_OK=inst-fb'), `Expected fallback shell output, got: ${buffer}`);
  });

  it('unsets BASH_ENV and restores ZDOTDIR/ES_PIPE_FALLBACK so child bash -c and zsh -c subshells never recursively relaunch agents', async () => {
    if (process.platform === 'win32') return;

    const dir = makeTempDir();
    const fakeBin = path.join(dir, 'bin');
    const emptyHome = path.join(dir, 'home');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(emptyHome, { recursive: true });

    const countFile = path.join(dir, 'codex-invocations.log');
    const fakeCodex = path.join(fakeBin, 'codex');
    // Fake codex logs each invocation and spawns child bash -c & zsh -c subshells.
    fs.writeFileSync(
      fakeCodex,
      [
        '#!/bin/sh',
        `echo "CALL" >> "${countFile}"`,
        'if [ -n "${RECURSED_GUARD:-}" ]; then echo "RECURSED_ERR"; exit 99; fi',
        'export RECURSED_GUARD=1',
        `/bin/bash -c 'echo SUB_BASH=\${BASH_ENV:-UNSET}'`,
        fs.existsSync('/bin/zsh') ? `/bin/zsh -c 'echo SUB_ZSH=\${ES_PIPE_FALLBACK:-UNSET}:\${ZDOTDIR:-UNSET}'` : 'echo "SUB_ZSH=UNSET:UNSET"',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const conn = {
      command: process.execPath,
      args: ['/fake/stdio.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', ES_MCP_DISCOVERY_DIR: '/tmp/disc', ES_MCP_INSTANCE_ID: 'i-sub', ES_MCP_WINDOW_ID: 'w-sub' }
    };
    const testEnv = { ...process.env, ...conn.env, HOME: emptyHome, PATH: `${fakeBin}:${process.env.PATH || ''}` };
    const workerPath = path.resolve(import.meta.dirname, '../../desktop/mcp-terminal-worker.cjs');

    async function runWorkerCheck(boot, pythonExecutable, label) {
      const worker = fork(workerPath, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...testEnv, ...boot.extraEnv, ELECTRON_RUN_AS_NODE: '1' }
      });

      let out = '';
      const exitMsgPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} child subshell test timeout; out=${out}`)), 8000);
        worker.on('message', msg => {
          if (msg.type === 'started') {
            worker.send({ type: 'write', data: 'exit\n' });
          } else if (msg.type === 'data') {
            out += msg.data;
          } else if (msg.type === 'exit') {
            clearTimeout(timer);
            resolve(msg);
          } else if (msg.type === 'failure') {
            clearTimeout(timer);
            reject(new Error(msg.error));
          }
        });
      });

      worker.send({
        type: 'start',
        shell: boot.shell,
        args: boot.args,
        pythonExecutable,
        options: { cols: 80, rows: 24, cwd: dir, env: { ...testEnv, ...boot.extraEnv } }
      });
      const exitMsg = await exitMsgPromise;
      return { exitMsg, out };
    }

    if (fs.existsSync('/bin/bash')) {
      const bootBashPipe = clientBootstrap('codex', conn, dir, { platform: 'darwin', shell: '/bin/bash', env: testEnv });
      const { exitMsg: bashExit, out: bashOut } = await runWorkerCheck(bootBashPipe, null, 'bash-piped');
      assert.equal(bashExit.exitCode, 0);
      assert.ok(bashOut.includes('SUB_BASH=UNSET'), `Expected BASH_ENV unset in child bash -c, got: ${bashOut}`);
      assert.ok(!bashOut.includes('RECURSED_ERR'), `Recursive es-codex loop detected in bash piped mode: ${bashOut}`);
      const bashCalls = fs.readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(bashCalls.length, 1, `Expected codex once in bash piped mode, got ${bashCalls.length}`);
      fs.writeFileSync(countFile, '', 'utf8');
      for (const d of bootBashPipe.cleanupDirs) fs.rmSync(d, { recursive: true, force: true });

      const pyExec = resolvePythonExecutable({ platform: process.platform, env: testEnv });
      if (pyExec) {
        const bootBashPty = clientBootstrap('codex', conn, dir, { platform: 'darwin', shell: '/bin/bash', env: testEnv });
        const { exitMsg: bashPtyExit, out: bashPtyOut } = await runWorkerCheck(bootBashPty, pyExec, 'bash-pty');
        assert.equal(bashPtyExit.exitCode, 0);
        assert.ok(bashPtyOut.includes('SUB_BASH=UNSET'), `Expected BASH_ENV unset in PTY bash -c, got: ${bashPtyOut}`);
        assert.ok(!bashPtyOut.includes('RECURSED_ERR'), `Recursive es-codex loop detected in bash PTY mode: ${bashPtyOut}`);
        const ptyCalls = fs.readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(ptyCalls.length, 1, `Expected codex once in bash PTY mode, got ${ptyCalls.length}`);
        fs.writeFileSync(countFile, '', 'utf8');
        for (const d of bootBashPty.cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
      }
    }

    if (fs.existsSync('/bin/zsh')) {
      const bootZsh = clientBootstrap('codex', conn, dir, { platform: 'darwin', shell: '/bin/zsh', env: testEnv });
      const { exitMsg, out } = await runWorkerCheck(bootZsh, null, 'zsh-piped');
      assert.equal(exitMsg.exitCode, 0);
      assert.ok(out.includes('SUB_ZSH=UNSET:UNSET'), `Expected ES_PIPE_FALLBACK & ZDOTDIR cleared in child zsh -c, got: ${out}`);
      assert.ok(!out.includes('RECURSED_ERR'), `Recursive es-codex loop detected in zsh piped fallback: ${out}`);
      const zshCalls = fs.readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(zshCalls.length, 1, `Expected codex once in zsh piped fallback, got ${zshCalls.length}`);
      for (const d of bootZsh.cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('force-kills SIGTERM-ignoring process groups on stop in both piped fallback and Python PTY modes', async () => {
    if (process.platform === 'win32') return;

    const dir = makeTempDir();

    // 1. Piped fallback mode: SIGTERM-ignoring child must still be force-killed within 250ms window
    const pipedHost = createTerminalHost({
      userDataPath: path.join(dir, 'piped'),
      resolvePython: () => null
    });
    terminalHosts.push(pipedHost);

    const pipedId = randomUUID();
    let pipedBuf = '';
    let pipedReadyResolve;
    const pipedReady = new Promise(resolve => { pipedReadyResolve = resolve; });
    let pipedExitResolve;
    const pipedExit = new Promise(resolve => { pipedExitResolve = resolve; });

    await pipedHost.start(11, { id: pipedId, cols: 80, rows: 24, client: 'shell' }, {
      connectionConfig: null,
      projectIndexPath: path.join(dir, 'proj.es'),
      publish(ev) {
        if (ev.type === 'data') {
          pipedBuf += ev.data;
          if (pipedBuf.includes('PIPED_TRAP_READY')) pipedReadyResolve();
        } else if (ev.type === 'exit') {
          pipedExitResolve(ev);
        }
      }
    });

    pipedHost.write(11, pipedId, 'trap "" TERM; echo PIPED_TRAP_READY; sleep 30\n');
    let t1;
    try {
      await Promise.race([pipedReady, new Promise((_, rej) => { t1 = setTimeout(() => rej(new Error(`Piped trap ready timeout: ${pipedBuf}`)), 5000); })]);
    } finally { clearTimeout(t1); }

    const stopStart = Date.now();
    pipedHost.stop(11, pipedId);
    let t2;
    try {
      await Promise.race([pipedExit, new Promise((_, rej) => { t2 = setTimeout(() => rej(new Error('Piped SIGKILL escalation timed out')), 4000); })]);
    } finally { clearTimeout(t2); }
    assert.ok(Date.now() - stopStart < 3000, 'Expected piped SIGTERM-ignoring process to die promptly via SIGKILL');

    // 2. Python PTY mode: startPythonPty.kill must allow mcp-pty-helper 1.5s SIGKILL child-group escalation
    const pidFile = path.join(dir, 'pty-hold.pid');
    const holdScript = path.join(dir, 'hold.sh');
    fs.writeFileSync(holdScript, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });

    const ptyHost = createTerminalHost({ userDataPath: path.join(dir, 'pty') });
    terminalHosts.push(ptyHost);
    const ptyId = randomUUID();
    let ptyBuf = '';
    let ptyExitResolve;
    const ptyExit = new Promise(resolve => { ptyExitResolve = resolve; });

    await ptyHost.start(12, { id: ptyId, cols: 80, rows: 24, client: 'shell' }, {
      connectionConfig: null,
      projectIndexPath: path.join(dir, 'proj.es'),
      publish(ev) {
        if (ev.type === 'data') ptyBuf += ev.data;
        else if (ev.type === 'exit') ptyExitResolve(ev);
      }
    });

    ptyHost.write(12, ptyId, `${holdScript}\n`);
    const pidDeadline = Date.now() + 6000;
    let childPid = NaN;
    while (Date.now() < pidDeadline) {
      if (fs.existsSync(pidFile)) {
        const parsed = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          childPid = parsed;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(Number.isInteger(childPid) && childPid > 0, `Expected hold.sh PID in ${pidFile}, ptyBuf=${ptyBuf}`);

    ptyHost.stop(12, ptyId);
    let t4;
    try {
      await Promise.race([ptyExit, new Promise((_, rej) => { t4 = setTimeout(() => rej(new Error('PTY child-group SIGKILL timed out')), 6000); })]);
    } finally { clearTimeout(t4); }

    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, `Expected PTY child process ${childPid} to be killed by helper SIGKILL escalation`);
  });
});
