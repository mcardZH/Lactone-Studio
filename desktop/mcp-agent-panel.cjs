'use strict';

const { createAssistantHost } = require('./mcp-assistant.cjs');
const { assistantSkillRoot } = require('./mcp-assistant-skill.cjs');
const { createTerminalHost } = require('./mcp-terminal.cjs');

function registerMcpAgentPanel({ handle, safeStorage, userDataPath, getWindowContext, trackTerminalWorker, skillLocation }) {
  const terminal = createTerminalHost({ userDataPath, trackWorker: trackTerminalWorker });
  const assistant = createAssistantHost({ userDataPath, safeStorage, skillRoot: assistantSkillRoot(skillLocation) });
  const owner = window => window.webContents.id;
  const publish = (window, channel) => payload => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  };
  const assistantContext = window => {
    const { listTools, callTool } = getWindowContext(window);
    return { listTools, callTool, publish: publish(window, 'sciyue:mcp-agent:assistant-event') };
  };

  handle('mcp-agent:terminal-start', (window, request) => {
    const context = getWindowContext(window);
    let connectionConfig;
    try { connectionConfig = context.connectionConfig; }
    catch (error) { if (request?.client !== 'powershell' && request?.client !== 'shell') throw error; }
    return terminal.start(owner(window), request, { connectionConfig, projectIndexPath: context.projectIndexPath, publish: publish(window, 'sciyue:mcp-agent:terminal-event') });
  });
  handle('mcp-agent:terminal-write', (window, id, data) => terminal.write(owner(window), id, data));
  handle('mcp-agent:terminal-resize', (window, id, cols, rows) => terminal.resize(owner(window), id, cols, rows));
  handle('mcp-agent:terminal-stop', (window, id) => terminal.stop(owner(window), id));
  handle('mcp-agent:assistant-settings', window => assistant.settings(owner(window)));
  handle('mcp-agent:assistant-models', (window, request) => assistant.models(owner(window), request));
  handle('mcp-agent:assistant-configure', (window, settings) => assistant.configure(owner(window), settings));
  handle('mcp-agent:assistant-send', (window, message) => assistant.send(owner(window), message, assistantContext(window)));
  handle('mcp-agent:assistant-continue', window => assistant.continue(owner(window), assistantContext(window)));
  handle('mcp-agent:assistant-guide', (window, message, waitingForImages) => assistant.guide(owner(window), message, waitingForImages));
  handle('mcp-agent:assistant-guide-images', (window, id, attachments) => assistant.guideImages(owner(window), id, attachments));
  handle('mcp-agent:assistant-save-instructions', (window, text) => assistant.saveInstructions(owner(window), text));
  handle('mcp-agent:assistant-cancel', window => assistant.cancel(owner(window)));
  handle('mcp-agent:assistant-reset', window => assistant.reset(owner(window)));
  return {
    closeOwner(id) {
      return settle(assistant.closeOwner(id), terminal.closeOwner(id));
    },
    close() {
      return settle(assistant.close(), terminal.close());
    },
  };
}

async function settle(...tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

module.exports = { registerMcpAgentPanel };
