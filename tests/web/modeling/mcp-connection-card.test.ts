import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { McpConnectionInfo } from '../../../src/modeling/contracts';
import McpConnectionCard, { MCP_CLIENT_SNIPPETS, maskMcpToken } from '../../../src/web/modeling/McpConnectionCard';
import { SETTINGS_PAGES } from '../../../src/web/modeling/SettingsPanel';

const sampleToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const info: McpConnectionInfo = {
	enabled: true,
	running: true,
	host: '127.0.0.1',
	port: 53123,
	pid: 4242,
	startedAt: '2026-11-11T03:00:00.000Z',
	version: '2.0.3',
	sessionFilePath: '/Users/u/Library/Application Support/Lactone/mcp-session.json',
	packaged: true,
	platform: 'darwin',
	token: sampleToken,
	httpUrl: 'http://127.0.0.1:53123/mcp',
	sseUrl: 'http://127.0.0.1:53123/sse',
	httpUrlWithToken: `http://127.0.0.1:53123/mcp?token=${sampleToken}`,
	sseUrlWithToken: `http://127.0.0.1:53123/sse?token=${sampleToken}`,
	launch: { command: '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio', args: ['/x/stdio-server.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
	configs: {
		serverName: 'lactone-studio',
		mcpServersJson: '{"mcpServers":{"lactone-studio":{"command":"node"}}}',
		claudeCodeCommand: 'claude mcp add lactone-studio --scope user',
		codexToml: '[mcp_servers.lactone-studio]\ncommand = "node"'
	},
	httpConfigs: {
		serverName: 'lactone-studio',
		mcpServersJson: `{"mcpServers":{"lactone-studio":{"url":"http://127.0.0.1:53123/mcp","headers":{"Authorization":"Bearer ${sampleToken}"}}}}`,
		claudeCodeCommand: `claude mcp add --transport http lactone-studio --scope user --header 'Authorization: Bearer ${sampleToken}' http://127.0.0.1:53123/mcp`,
		codexToml: `[mcp_servers.lactone-studio]\nurl = "http://127.0.0.1:53123/mcp?token=${sampleToken}"`
	}
};

const desktop = {
	mcpConnectionInfo: async () => info,
	setMcpConnectionEnabled: async () => info,
	rotateMcpConnectionToken: async () => info,
	testMcpConnection: async () => ({ ok: true, workbenchOnline: true, info })
};

describe('Settings › AI 协作 (MCP) connection card', () => {
	it('registers the MCP settings page', () => {
		expect(SETTINGS_PAGES.some(([id, label]) => id === 'mcp' && label === 'AI 协作 (MCP)')).toBe(true);
	});

	it('renders HTTP & SSE endpoints, masked token controls, and HTTP client snippets by default', () => {
		const html = renderToStaticMarkup(createElement(McpConnectionCard, { desktop, initialInfo: info }));
		expect(html).toContain('启用 MCP 服务');
		expect(html).toContain('运行中 · 127.0.0.1:53123 · PID 4242');
		expect(html).toContain(info.sessionFilePath);
		expect(html).toContain('http://127.0.0.1:53123/mcp');
		expect(html).toContain('http://127.0.0.1:53123/sse');
		expect(html).toContain(maskMcpToken(sampleToken));
		expect(html).toContain('显示密钥');
		expect(html).toContain('复制密钥');
		expect(html).toContain('重置密钥');
		expect(html).toContain('复制带密钥 URL');
		expect(MCP_CLIENT_SNIPPETS.map(s => s.key)).toEqual(['mcpServersJson', 'claudeCodeCommand', 'codexToml']);
		for (const snippet of MCP_CLIENT_SNIPPETS) expect(html).toContain(`data-testid="mcp-snippet-${snippet.key}"`);
		expect(html).toContain('claude mcp add --transport http lactone-studio');
		expect(html).toContain('[mcp_servers.lactone-studio]');
	});

	it('renders stdio snippets when initialTransportTab is stdio', () => {
		const html = renderToStaticMarkup(createElement(McpConnectionCard, { desktop, initialInfo: info, initialTransportTab: 'stdio' }));
		expect(html).toContain('claude mcp add lactone-studio --scope user');
		expect(html).toContain('command = &quot;node&quot;');
	});

	it('shows a stopped state and a desktop-only notice when unavailable', () => {
		const stopped = renderToStaticMarkup(createElement(McpConnectionCard, { desktop, initialInfo: { ...info, enabled: false, running: false, host: null, port: null } }));
		expect(stopped).toContain('未运行');
		expect(stopped).toContain('MCP 服务停用时');
		const web = renderToStaticMarkup(createElement(McpConnectionCard, {}));
		expect(web).toContain('仅在桌面版中可用');
	});
});
