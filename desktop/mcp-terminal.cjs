'use strict';

const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');

const clients = new Set(['shell', 'powershell', 'codex', 'claude', 'dsh']);
const agentCommands = { codex: 'es-codex', claude: 'es-claude', dsh: 'es-dsh' };
const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const powershellQuote = value => `'${value.replaceAll("'", "''")}'`;
const posixSingleQuote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const dimension = value => Number.isInteger(value) && value > 0 && value <= 32767;

const launchConsoleApplication = String.raw`
if ($esClient.CommandType -eq 'Application' -and $esClient.Source -like '*.exe') {
  $esProcessInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $esProcessInfo.FileName = $esClient.Source
  $esProcessInfo.UseShellExecute = $false
  if ($PWD.Provider.Name -eq 'FileSystem') { $esProcessInfo.WorkingDirectory = $PWD.ProviderPath }
  $esProcessInfo.Arguments = ($esArguments | ForEach-Object {
    $esEscaped = ([string]$_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1'
    '"' + $esEscaped + '"'
  }) -join ' '
  $esProcess = [System.Diagnostics.Process]::Start($esProcessInfo)
  try { $esProcess.WaitForExit(); $global:LASTEXITCODE = $esProcess.ExitCode }
  finally { $esProcess.Dispose() }
} else {
  & $esClient @esArguments
}`;

function windowsClientCommand(client, connection, dataDirectory) {
  const server = {
    command: connection.command,
    args: [...connection.args, '--client', client],
    env: connection.env,
  };
  let file;
  let commandArguments;
  if (client === 'codex') {
    const tomlEnv = Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
    const config = `mcp_servers.ester_studio={command=${JSON.stringify(server.command)}, args=${JSON.stringify(server.args)}, env={${tomlEnv}}}`;
    const literal = value => value.includes("'''") ? JSON.stringify(value) : `'''${value}'''`;
    const shimEnv = Object.entries(server.env).map(([key, value]) => `${key}=${literal(value)}`).join(', ');
    const shimConfig = `mcp_servers.ester_studio={command=${literal(server.command)}, args=[${server.args.map(literal).join(', ')}], env={${shimEnv}}}`;
    commandArguments = `$esArguments = @('-c', ${powershellQuote(config)}) + $args\nif ($esClient.Source -like '*.cmd') { $esArguments[1] = ${powershellQuote(shimConfig)} }`;
  } else {
    mkdirSync(dataDirectory, { recursive: true });
    const claude = client === 'claude';
    file = join(dataDirectory, `${randomUUID()}${claude ? '.json' : '.yml'}`);
    const contents = claude ? { mcpServers: { ester_studio: { type: 'stdio', ...server } } } : [{
      insert: [{ id: 'mcp-ester-studio', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'ester_studio', transport: 'stdio', ...server } }],
    }];
    writeFileSync(file, JSON.stringify(contents, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    commandArguments = claude ? `$esArguments = $args + @('--mcp-config', ${powershellQuote(file)})` : `$esArguments = @('--profile', 'tui', '--patch', ${powershellQuote(file)}) + $args`;
  }
  const body = `$esClient = Get-Command ${client}.exe,${client}.cmd,${client} -ErrorAction SilentlyContinue | Select-Object -First 1\nif ($esClient) {\n${commandArguments}\n${launchConsoleApplication}\n} else {\nWrite-Host 'Lactone Studio: ${client} was not found on PATH.'\n}`;
  return { file, body };
}

function posixClientCommand(client, connection, sessionDir) {
  const server = {
    command: connection.command,
    args: [...connection.args, '--client', client],
    env: connection.env,
  };
  let file;
  let execLine;
  if (client === 'codex') {
    const tomlEnv = Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
    const config = `mcp_servers.ester_studio={command=${JSON.stringify(server.command)}, args=${JSON.stringify(server.args)}, env={${tomlEnv}}}`;
    execLine = `command ${client} -c ${posixSingleQuote(config)} "$@"`;
  } else {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const claude = client === 'claude';
    file = join(sessionDir, `${randomUUID()}${claude ? '.json' : '.yml'}`);
    const contents = claude ? { mcpServers: { ester_studio: { type: 'stdio', ...server } } } : [{
      insert: [{ id: 'mcp-ester-studio', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'ester_studio', transport: 'stdio', ...server } }],
    }];
    writeFileSync(file, JSON.stringify(contents, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    execLine = claude
      ? `command ${client} "$@" --mcp-config ${posixSingleQuote(file)}`
      : `command ${client} --profile tui --patch ${posixSingleQuote(file)} "$@"`;
  }
  const fnName = agentCommands[client];
  const fnBody = [
    `${fnName}() {`,
    `  if command -v ${client} >/dev/null 2>&1; then`,
    `    ${execLine}`,
    '  else',
    `    printf '%s\\n' ${posixSingleQuote(`Lactone Studio: ${client} was not found on PATH.`)}`,
    '    return 127',
    '  fi',
    '}',
  ].join('\n');
  return { file, fnName, fnBody };
}

function resolvePosixShell({ platform = process.platform, env = process.env } = {}) {
  const requested = typeof env.SHELL === 'string' ? env.SHELL.trim() : '';
  const candidates = [
    requested,
    platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    '/bin/bash',
    '/bin/zsh',
    '/bin/sh',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return candidate;
    }
  }
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

function resolvePythonExecutable({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  resourcesPath = process.resourcesPath,
  devRoot = resolve(__dirname, '..'),
  systemCandidates = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'],
} = {}) {
  if (platform === 'win32') return null;
  const candidates = [];
  if (resourcesPath) {
    // Packaged macOS/Linux bundles place Python directly under <resourcesPath>/chemistry/python (matching desktop/runtime.cjs).
    candidates.push(join(resourcesPath, 'chemistry', 'python', 'bin', 'python3'));
  }
  if (typeof env.SCIYUE_PYTHON === 'string' && env.SCIYUE_PYTHON.trim()) {
    candidates.push(env.SCIYUE_PYTHON.trim());
  }
  const platformTag = `${platform}-${arch}`;
  const archTag = arch === 'arm64' ? 'arm64' : 'x64';
  candidates.push(
    join(devRoot, '.local', 'toolchains', platformTag, `conda-py312-${archTag}`, 'python', 'bin', 'python3'),
    ...systemCandidates
  );
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return candidate;
    }
  }
  return null;
}

function posixBootstrap(client, connection, dataDirectory, { shellPath, env = process.env } = {}) {
  const sessionDir = join(dataDirectory, randomUUID());
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const files = [];
  const cleanupDirs = [sessionDir];
  const fnBlocks = [];
  const baseShell = basename(shellPath || '/bin/sh').toLowerCase();
  const useZsh = baseShell === 'zsh';
  const useBash = baseShell === 'bash';
  const defaultSelected = client === 'shell' || client === 'powershell';

  if (connection) {
    for (const name of Object.keys(agentCommands)) {
      const { file, fnBody } = posixClientCommand(name, connection, sessionDir);
      if (file) files.push(file);
      fnBlocks.push(fnBody);
    }
  }

  const helperScript = join(sessionDir, 'ls-init.sh');
  const autoStart = !defaultSelected && agentCommands[client] ? `${agentCommands[client]}\n` : '';
  writeFileSync(helperScript, `${fnBlocks.join('\n')}\n${autoStart}`, { encoding: 'utf8', mode: 0o600 });
  files.push(helperScript);

  if (useZsh) {
    const zdotDir = join(sessionDir, 'zdotdir');
    mkdirSync(zdotDir, { recursive: true, mode: 0o700 });
    const origZdot = env.ZDOTDIR && isAbsolute(env.ZDOTDIR) ? env.ZDOTDIR : '$HOME';
    const zshrcPath = join(zdotDir, '.zshrc');
    writeFileSync(
      join(zdotDir, '.zshenv'),
      [
        `[ -f ${origZdot === '$HOME' ? '"$HOME/.zshenv"' : `${posixSingleQuote(origZdot)}/.zshenv`} ] && . ${origZdot === '$HOME' ? '"$HOME/.zshenv"' : `${posixSingleQuote(origZdot)}/.zshenv`}`,
        `if [ ! -o interactive ] && [ -n "\${ES_PIPE_FALLBACK:-}" ]; then`,
        '  unset ES_PIPE_FALLBACK',
        `  . ${posixSingleQuote(zshrcPath)}`,
        'fi',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    writeFileSync(join(zdotDir, '.zprofile'), `[ -f ${origZdot === '$HOME' ? '"$HOME/.zprofile"' : `${posixSingleQuote(origZdot)}/.zprofile`} ] && . ${origZdot === '$HOME' ? '"$HOME/.zprofile"' : `${posixSingleQuote(origZdot)}/.zprofile`}\n`, { mode: 0o600 });
    const zshrcLines = [
      `if [ -n "\${ES_ORIG_ZDOTDIR:-}" ]; then export ZDOTDIR="$ES_ORIG_ZDOTDIR"; else unset ZDOTDIR; fi`,
      'unset ES_ORIG_ZDOTDIR',
      `[ -f "${origZdot === '$HOME' ? '$HOME/.zshrc' : `${origZdot}/.zshrc`}" ] && . "${origZdot === '$HOME' ? '$HOME/.zshrc' : `${origZdot}/.zshrc`}"`,
      `. ${posixSingleQuote(helperScript)}`,
    ];
    writeFileSync(zshrcPath, zshrcLines.join('\n') + '\n', { mode: 0o600 });
    return {
      shell: shellPath,
      args: ['-i'],
      extraEnv: {
        ZDOTDIR: zdotDir,
        ...(env.ZDOTDIR ? { ES_ORIG_ZDOTDIR: env.ZDOTDIR } : {}),
      },
      files,
      cleanupDirs,
    };
  }

  if (useBash) {
    const bashrc = join(sessionDir, 'bashrc');
    const bashrcLines = [
      'unset BASH_ENV',
      '[ -f /etc/profile ] && . /etc/profile',
      'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; elif [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; fi',
      `. ${posixSingleQuote(helperScript)}`,
    ];
    writeFileSync(bashrc, bashrcLines.join('\n') + '\n', { mode: 0o600 });
    return {
      shell: shellPath,
      args: ['--rcfile', bashrc, '-i'],
      extraEnv: { BASH_ENV: bashrc },
      files,
      cleanupDirs,
    };
  }

  return {
    shell: existsSync('/bin/bash') ? '/bin/bash' : shellPath,
    args: ['-i'],
    extraEnv: { ENV: helperScript },
    files,
    cleanupDirs,
  };
}

function clientBootstrap(client, connection, dataDirectory, { platform = process.platform, shell, env = process.env } = {}) {
  const defaultShellClient = client === 'powershell' || client === 'shell';
  if (!connection && !defaultShellClient) {
    throw new Error('当前窗口的 MCP 连接尚未就绪。');
  }
  if (platform === 'win32') {
    if (!connection) return { args: ['-NoLogo'], files: [], cleanupDirs: [], extraEnv: {} };
    const files = [];
    const scripts = [];
    let selected;
    try {
      for (const [name, command] of Object.entries(agentCommands)) {
        const { file, body } = windowsClientCommand(name, connection, dataDirectory);
        if (file) files.push(file);
        scripts.push(`if (-not (Get-Command ${command} -ErrorAction SilentlyContinue)) {\nfunction ${command} {\n${body}\n}\n}`);
        if (name === client) selected = `& {\n${body}\n}`;
      }
    } catch (error) {
      removeConfigs(files);
      throw error;
    }
    if (selected) scripts.push(selected);
    return { args: ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(scripts.join('\n'), 'utf16le').toString('base64')], files, cleanupDirs: [], extraEnv: {} };
  }
  return posixBootstrap(client, connection, dataDirectory, { shellPath: shell || resolvePosixShell({ platform, env }), env });
}

function removeConfigs(files = [], cleanupDirs = []) {
  const errors = [];
  for (const file of files) {
    try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
  }
  for (const dir of cleanupDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  return errors.length > 0;
}

function projectDirectory(projectIndexPath) {
  if (typeof projectIndexPath === 'string' && isAbsolute(projectIndexPath)) {
    const directory = dirname(projectIndexPath);
    if (statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return directory;
  }
  return homedir();
}

function createTerminalHost({ userDataPath, resolvePython = resolvePythonExecutable, resourcesPath = process.resourcesPath }) {
  const sessions = new Map();
  const current = (owner, id) => {
    const session = sessions.get(owner);
    return session?.id === id ? session : undefined;
  };
  function stop(session) {
    if (session.stopping) return;
    session.stopping = true;
    send(session, { type: 'stop' });
  }
  function send(session, message) {
    if (session.worker.connected) session.worker.send(message, error => {
      if (error && session.worker.connected) session.worker.kill();
    });
  }
  function start(owner, request, { connectionConfig, projectIndexPath, publish }) {
    if (!request || !sessionIdPattern.test(request.id) || !dimension(request.cols) || !dimension(request.rows) || !clients.has(request.client)) {
      throw new Error('终端会话参数无效。');
    }
    if (sessions.has(owner)) throw new Error('此窗口已有终端。');
    const cwd = projectDirectory(projectIndexPath);
    const platform = process.platform;
    const shell = platform === 'win32'
      ? join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : resolvePosixShell({ platform, env: process.env });
    const { args, files, cleanupDirs, extraEnv } = clientBootstrap(
      request.client,
      connectionConfig,
      join(userDataPath, 'mcp-terminal'),
      { platform, shell, env: process.env }
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase();
      return name !== 'ELECTRON_RUN_AS_NODE' && !name.startsWith('ES_MCP_');
    }));
    for (const [key, value] of Object.entries(connectionConfig?.env ?? {})) {
      if (key.startsWith('ES_MCP_')) env[key] = value;
    }
    Object.assign(env, extraEnv || {});
    env.TERM = 'xterm-256color';
    const pythonExecutable = resolvePython({ platform, env: process.env, resourcesPath });
    let worker;
    try {
      worker = fork(join(__dirname, 'mcp-terminal-worker.cjs'), [], {
        windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      });
    } catch (error) {
      removeConfigs(files, cleanupDirs);
      throw new Error(`终端启动失败。${error.message}`);
    }
    const session = {
      id: request.id, worker, cols: request.cols, rows: request.rows,
      done: new Promise(resolveDone => worker.once('close', resolveDone)),
    };
    sessions.set(owner, session);
    return new Promise((resolveStart, rejectStart) => {
      let started = false;
      let error;
      let exit;
      worker.on('message', message => {
        if (message.type === 'started') {
          started = true;
          resolveStart({ id: session.id, pid: message.pid });
        } else if (message.type === 'data' && !session.retired) publish({ type: 'data', id: session.id, data: message.data });
        else if (message.type === 'failure') error = message.error;
        else if (message.type === 'exit') exit = message;
      });
      worker.on('error', cause => { error = cause.message; });
      worker.once('close', (code, signal) => {
        sessions.delete(owner);
        const cleanupError = removeConfigs(files, cleanupDirs);
        if (!started) { rejectStart(new Error(`终端启动失败。${error ?? `终端进程退出 (${code ?? signal})。`}`)); return; }
        const warning = error ?? (cleanupError ? '无法移除本次连接的临时配置。' : undefined)
          ?? (!exit && code ? `终端进程异常退出（${code}）。` : undefined);
        if (!session.retired) publish({ type: 'exit', id: session.id, exitCode: exit?.exitCode, signal: exit?.signal ?? signal, warning });
      });
      send(session, {
        type: 'start',
        shell,
        args,
        pythonExecutable,
        options: { name: 'xterm-256color', cols: request.cols, rows: request.rows, cwd, env, useConpty: true, useConptyDll: true },
      });
    });
  }
  function closeOwner(owner) {
    const session = sessions.get(owner);
    if (!session) return;
    session.retired = true;
    stop(session);
    return session.done;
  }
  return {
    start,
    write(owner, id, data) {
      if (typeof data !== 'string') throw new Error('终端输入必须是文本。');
      const session = current(owner, id);
      if (session && !session.stopping) send(session, { type: 'write', data });
    },
    resize(owner, id, cols, rows) {
      if (!dimension(cols) || !dimension(rows)) throw new Error('终端尺寸无效。');
      const session = current(owner, id);
      if (!session?.worker.connected || session.stopping || (session.cols === cols && session.rows === rows)) return;
      send(session, { type: 'resize', cols, rows });
      Object.assign(session, { cols, rows });
    },
    stop(owner, id) {
      const session = current(owner, id);
      if (session) stop(session);
    },
    closeOwner,
    close() { return Promise.all([...sessions.keys()].map(closeOwner)); },
  };
}

module.exports = { createTerminalHost, clientBootstrap, resolvePosixShell, resolvePythonExecutable };
