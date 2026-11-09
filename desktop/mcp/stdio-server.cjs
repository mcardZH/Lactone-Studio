#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const packageMeta = require('../../package.json');
const {
  createMcpToolRegistry,
  registerFoundationTools,
  registerWindowAndFileTools,
  createMcpProtocolProcessor,
  jsonRpcError
} = require('./protocol.cjs');
const { createMcpLiveClient } = require('./live-bridge.cjs');

function createMcpStdioServer({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  sessionFilePath,
  dispatchToHost,
  serverName = 'ester-studio-mcp',
  serverVersion = packageMeta.version || '2.0.3',
  registerExtraTools
} = {}) {
  const client = typeof dispatchToHost === 'function'
    ? null
    : createMcpLiveClient({ sessionFilePath });

  const dispatch = typeof dispatchToHost === 'function'
    ? dispatchToHost
    : (action, payload) => client.dispatch(action, payload);

  const registry = createMcpToolRegistry();
  registerFoundationTools(registry, {
    dispatchToHost: dispatch,
    serverVersion
  });
  registerWindowAndFileTools(registry, {
    dispatchToHost: dispatch,
    serverVersion
  });
  if (typeof registerExtraTools === 'function') {
    registerExtraTools(registry, { dispatchToHost: dispatch, serverVersion });
  }

  const processor = createMcpProtocolProcessor({
    registry,
    serverName,
    serverVersion
  });

  let rl = null;
  let closed = false;

  function writeMessage(payload) {
    if (closed || !payload) return;
    output.write(`${JSON.stringify(payload)}\n`);
  }

  async function processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      writeMessage(jsonRpcError(null, -32700, `Parse error: ${error.message}`));
      return;
    }

    try {
      const response = await processor.handleMessage(parsed);
      if (response) {
        writeMessage(response);
      }
    } catch (error) {
      errorOutput?.write?.(`[ester-studio-mcp] Unhandled error: ${error?.stack || error}\n`);
      if (parsed && parsed.id !== undefined) {
        writeMessage(jsonRpcError(parsed.id, -32603, error instanceof Error ? error.message : String(error)));
      }
    }
  }

  function start() {
    if (rl) return;
    rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false
    });
    rl.on('line', line => {
      void processLine(line);
    });
    rl.on('close', () => {
      closed = true;
    });
  }

  function close() {
    closed = true;
    if (rl) {
      rl.close();
      rl = null;
    }
  }

  return Object.freeze({
    start,
    close,
    processLine,
    registry,
    processor,
    client
  });
}

if (require.main === module) {
  const server = createMcpStdioServer();
  server.start();
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
}

module.exports = {
  createMcpStdioServer
};
