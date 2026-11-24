'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// Owning each PTY/shell supervisor in a dedicated worker process guarantees
// descriptors and child process groups are torn down cleanly when closed.
let terminal;
let stopping = false;
let chunks = [];
let flushJob;

function flush() {
  if (flushJob) clearImmediate(flushJob);
  flushJob = undefined;
  if (!chunks.length) return;
  if (process.connected) process.send({ type: 'data', data: chunks.join('') });
  chunks = [];
}

function enqueueData(text) {
  if (!text || !process.connected) return;
  chunks.push(text);
  flushJob ??= setImmediate(flush);
}

function finish(message, exitCode) {
  flush();
  if (process.connected) process.send(message, () => process.exit(exitCode));
  else process.exit(exitCode);
}

function stop() {
  if (!terminal || stopping) return;
  stopping = true;
  terminal.kill();
}

function tryLoadOptionalNodePty() {
  if (process.platform !== 'win32') return null;
  try { return require('node-pty'); }
  catch { return null; }
}

function startPythonPty(message, onPreStartFailure) {
  const helperPath = path.join(__dirname, 'mcp-pty-helper.py');
  const cols = Number(message.options?.cols || 80);
  const rows = Number(message.options?.rows || 24);
  const child = spawn(
    message.pythonExecutable,
    ['-I', '-B', '-u', helperPath, String(cols), String(rows), message.shell, ...(message.args || [])],
    {
      cwd: message.options?.cwd,
      env: message.options?.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let startedSent = false;
  let exitReported = false;
  let fellBack = false;
  let helperExited = false;
  let helperKillTimer;
  let stderrTail = '';

  const fallbackIfPreStart = reason => {
    if (startedSent || stopping || fellBack || !onPreStartFailure) return false;
    fellBack = true;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    onPreStartFailure(reason);
    return true;
  };

  const reportExit = (exitCode, signal) => {
    if (exitReported || fellBack) return;
    exitReported = true;
    const remainder = decoder.end();
    if (remainder) enqueueData(remainder);
    finish({ type: 'exit', exitCode, signal }, 0);
  };

  const handleLine = line => {
    if (fellBack) return;
    if (line.startsWith('P:')) {
      const pid = Number.parseInt(line.slice(2), 10);
      startedSent = true;
      if (process.connected) process.send({ type: 'started', pid: Number.isFinite(pid) ? pid : child.pid });
    } else if (line.startsWith('D:')) {
      const text = decoder.write(Buffer.from(line.slice(2), 'base64'));
      if (text) enqueueData(text);
    } else if (line.startsWith('E:')) {
      const [codeRaw, sigRaw] = line.slice(2).split(',', 2);
      const exitCode = codeRaw ? Number.parseInt(codeRaw, 10) : null;
      const signal = sigRaw ? Number.parseInt(sigRaw, 10) : null;
      reportExit(exitCode, signal);
    } else if (line.startsWith('F:')) {
      const messageText = line.slice(2) || 'PTY helper failure';
      if (!fallbackIfPreStart(messageText)) {
        finish({ type: 'failure', error: messageText }, 1);
      }
    }
  };

  child.stdout.on('data', chunk => {
    if (fellBack) return;
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2048);
  });
  child.stdin.on('error', () => {});
  child.on('error', error => {
    helperExited = true;
    if (helperKillTimer) clearTimeout(helperKillTimer);
    if (!fallbackIfPreStart(error.message)) {
      finish({ type: 'failure', error: error.message }, 1);
    }
  });
  child.once('close', (code, signal) => {
    helperExited = true;
    if (helperKillTimer) clearTimeout(helperKillTimer);
    if (fellBack) return;
    if (!startedSent) {
      const reason = stderrTail.trim() || `PTY 辅助进程未就绪 (${code ?? signal})`;
      if (!fallbackIfPreStart(reason)) {
        finish({ type: 'failure', error: reason }, 1);
      }
      return;
    }
    reportExit(code, signal);
  });

  return {
    write(data) {
      if (!fellBack && child.stdin.writable) {
        child.stdin.write(`I:${Buffer.from(data, 'utf8').toString('base64')}\n`);
      }
    },
    resize(nextCols, nextRows) {
      if (!fellBack && child.stdin.writable) {
        child.stdin.write(`R:${nextCols},${nextRows}\n`);
      }
    },
    kill() {
      if (child.stdin.writable) {
        try {
          child.stdin.write('Q\n');
          child.stdin.end();
        } catch { /* ignore */ }
      }
      // Allow mcp-pty-helper.py its 1.5s SIGTERM -> SIGKILL child-group escalation before force-killing Python.
      helperKillTimer ??= setTimeout(() => {
        if (!helperExited && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2200);
      helperKillTimer.unref?.();
    },
  };
}

function startPipedFallback(message) {
  const rawArgs = message.args || [];
  // Strip interactive -i / --rcfile flags on POSIX when no PTY is attached so shells read stdin pipes cleanly.
  const args = process.platform === 'win32'
    ? rawArgs
    : rawArgs.filter((arg, idx) => arg !== '-i' && arg !== '--rcfile' && rawArgs[idx - 1] !== '--rcfile');
  const env = process.platform === 'win32'
    ? message.options?.env
    : { ...(message.options?.env || {}), ES_PIPE_FALLBACK: '1' };
  const useProcessGroup = process.platform !== 'win32';
  const child = spawn(message.shell, args, {
    cwd: message.options?.cwd,
    env,
    detached: useProcessGroup,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  let startedSent = false;
  let exited = false;
  let killTimer;

  const signalTarget = signal => {
    if (useProcessGroup && Number.isInteger(child.pid) && child.pid > 0) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch { /* fall through to direct child signal */ }
    }
    try { child.kill(signal); } catch { /* ignore */ }
  };

  child.once('spawn', () => {
    startedSent = true;
    if (process.connected) process.send({ type: 'started', pid: child.pid });
  });
  child.stdout.on('data', chunk => enqueueData(outDecoder.write(chunk)));
  child.stderr.on('data', chunk => enqueueData(errDecoder.write(chunk)));
  child.stdin.on('error', () => {});
  child.on('error', error => {
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    if (!startedSent) finish({ type: 'failure', error: error.message }, 1);
  });
  child.once('close', (exitCode, signal) => {
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    const restOut = outDecoder.end();
    const restErr = errDecoder.end();
    if (restOut) enqueueData(restOut);
    if (restErr) enqueueData(restErr);
    if (!startedSent) {
      finish({ type: 'failure', error: `终端进程未就绪 (${exitCode ?? signal})` }, 1);
      return;
    }
    finish({ type: 'exit', exitCode, signal }, 0);
  });

  return {
    write(data) {
      if (!child.stdin.writable) return;
      // In non-PTY pipe mode, map CR from xterm Enter to LF for shells reading stdin lines.
      const normalized = process.platform === 'win32' ? data : data.replace(/\r/g, '\n');
      child.stdin.write(normalized);
    },
    resize() {
      // Piped fallback has no TTY ioctl to resize; no-op keeps UI responsive.
    },
    kill() {
      try { child.stdin.end(); } catch { /* ignore */ }
      if (!exited && child.exitCode === null && child.signalCode === null) {
        signalTarget('SIGTERM');
      }
      killTimer ??= setTimeout(() => {
        if (!exited && child.exitCode === null && child.signalCode === null) {
          signalTarget('SIGKILL');
        }
      }, 250);
      killTimer.unref?.();
    },
  };
}

function startTerminal(message) {
  const nodePty = tryLoadOptionalNodePty();
  if (nodePty) {
    const instance = nodePty.spawn(message.shell, message.args, message.options);
    instance.onData(data => enqueueData(data));
    instance.onExit(({ exitCode, signal }) => finish({ type: 'exit', exitCode, signal }, 0));
    process.send({ type: 'started', pid: instance.pid });
    return {
      write: data => instance.write(data),
      resize: (cols, rows) => instance.resize(cols, rows),
      kill: () => instance.kill(),
    };
  }
  if (process.platform !== 'win32' && message.pythonExecutable) {
    let fallingBack = false;
    let current = startPythonPty(message, () => {
      if (fallingBack || stopping) return;
      fallingBack = true;
      current = startPipedFallback(message);
    });
    return {
      write: data => current.write(data),
      resize: (cols, rows) => current.resize(cols, rows),
      kill: () => current.kill(),
    };
  }
  return startPipedFallback(message);
}

process.on('message', message => {
  try {
    if (!terminal) {
      if (message.type !== 'start') return;
      terminal = startTerminal(message);
    } else if (message.type === 'stop') stop();
    else if (!stopping && message.type === 'write') terminal.write(message.data);
    else if (!stopping && message.type === 'resize') terminal.resize(message.cols, message.rows);
  } catch (error) {
    finish({ type: 'failure', error: error.message }, 1);
  }
});

process.on('disconnect', () => {
  if (terminal) stop();
  else process.exit(0);
});
