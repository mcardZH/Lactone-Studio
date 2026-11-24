import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AgentAssistant, { ReplyRow } from '../../../src/web/mcp/AgentAssistant';
import AgentTerminal from '../../../src/web/mcp/AgentTerminal';
import { ES_MCP_SETUP_PROMPT } from '../../../src/web/mcp/setup-prompt';
import type { AgentPanelBridge } from '../../../src/web/mcp/agent-panel-bridge';

const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const { createAssistantHost, createSettingsStore } = require(path.join(repoRoot, 'desktop/mcp-assistant.cjs'));

const sampleSettings = {
  provider: 'openai' as const,
  profiles: {
    deepseek: { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', protocol: 'chat' as const, keyRequired: true, hasKey: false, remembered: false },
    openai: { model: 'gpt-6.2-sol', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' as const, keyRequired: true, hasKey: false, remembered: false },
    claude: { model: '', baseUrl: 'https://api.anthropic.com/v1', protocol: 'messages' as const, keyRequired: true, hasKey: false, remembered: false },
    gemini: { model: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'chat' as const, keyRequired: true, hasKey: false, remembered: false },
    ollama: { model: '', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'chat' as const, keyRequired: false, hasKey: false, remembered: false },
    kimi: { model: '', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'chat' as const, keyRequired: true, hasKey: false, remembered: false },
    glm: { model: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat' as const, keyRequired: true, hasKey: false, remembered: false },
    custom: { model: '', baseUrl: '', protocol: 'chat' as const, keyRequired: true, hasKey: false, remembered: false },
  },
  canRemember: false,
  busy: false,
  paused: false,
  customInstructions: '',
};

function stubBridge(): AgentPanelBridge {
  return {
    terminalStart: async request => ({ id: request.id, pid: 1000 }),
    terminalWrite: async () => {},
    terminalResize: async () => {},
    terminalStop: async () => {},
    onTerminalEvent: () => () => {},
    assistantSettings: async () => sampleSettings,
    assistantModels: async () => ({ models: [] }),
    assistantConfigure: async () => { throw new Error('unused'); },
    assistantSend: async () => ({ status: 'completed' }),
    assistantContinue: async () => ({ status: 'completed' }),
    assistantGuide: async () => true,
    assistantGuideImages: async () => true,
    assistantSaveInstructions: async () => { throw new Error('unused'); },
    assistantCancel: async () => {},
    assistantReset: async () => {},
    onAssistantEvent: () => () => {},
  };
}

describe('Adapted AgentTerminal, AgentAssistant, and setup prompt', () => {
  it('removes node-pty from package.json and renders AgentTerminal with POSIX shell default and Codex/Claude/dsh choices', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['node-pty']).toBeUndefined();

    const html = renderToStaticMarkup(
      createElement(AgentTerminal, { bridge: stubBridge(), visible: true, floating: false })
    );
    expect(html).toContain('value="shell"');
    expect(html).toContain('value="codex"');
    expect(html).toContain('value="claude"');
    expect(html).toContain('value="dsh"');
    expect(html).toContain('打开终端');
  });

  it('renders Lactone Studio branding + disabled keychain warning in DOM and enforces safeStorage in mcp-assistant.cjs', () => {
    const settingsHtml = renderToStaticMarkup(
      createElement(AgentAssistant, {
        bridge: stubBridge(),
        initialSettings: sampleSettings,
        initialConfiguredOpen: true,
      })
    );
    expect(settingsHtml).toContain('服务设置');
    expect(settingsHtml).toContain('当前环境系统钥匙串加密不可用，密钥仅限本次会话使用。');
    expect(settingsHtml).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);

    const replyHtml = renderToStaticMarkup(
      createElement(ReplyRow, {
        entry: { id: 'r1', turnId: 't1', type: 'assistant', text: 'Lactone ready' },
        turnActive: false,
      })
    );
    expect(replyHtml).toContain('alt="Lactone Studio"');

    const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lactone-assist-test-'));
    try {
      const store = createSettingsStore(tempUserDir, { isEncryptionAvailable: () => false });
      expect(store.canRemember()).toBe(false);
      expect(() =>
        store.update('openai', { model: 'gpt-6.2-sol', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' }, 'sk-test', true)
      ).toThrow('系统密钥加密当前不可用。');

      const host = createAssistantHost({
        userDataPath: tempUserDir,
        safeStorage: { isEncryptionAvailable: () => false },
        mcpHost: { listTools: () => [], callLocal: async () => ({}), onCatalogChanged: () => () => {} },
        publish: () => {},
      });
      const cfg = host.settings(1);
      expect(cfg.canRemember).toBe(false);
      expect(host.configure(1, { provider: 'openai', model: 'gpt-6.2-sol', apiKey: 'sk-session', remember: false }).profiles.openai.hasKey).toBe(true);
    } finally {
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }

    expect(ES_MCP_SETUP_PROMPT).toContain('Lactone Studio');
    expect(ES_MCP_SETUP_PROMPT).toContain('macOS');
    expect(ES_MCP_SETUP_PROMPT).toContain('Linux');
    expect(ES_MCP_SETUP_PROMPT).toContain('Windows');
    expect(ES_MCP_SETUP_PROMPT).toContain('stdio-server.cjs');
  });
});
