import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, McpConnectionInfo } from '../../modeling/contracts';
import { copyPlainText } from '../clipboard-text';

export type McpConnectionDesktop = Pick<
  DesktopBridge,
  'mcpConnectionInfo' | 'setMcpConnectionEnabled' | 'rotateMcpConnectionToken' | 'testMcpConnection'
>;

export type McpTransportTab = 'http' | 'stdio';

type SnippetKey = 'mcpServersJson' | 'claudeCodeCommand' | 'codexToml';

export const MCP_CLIENT_SNIPPETS: readonly { key: SnippetKey; title: string; hint: string }[] = [
  {
    key: 'mcpServersJson',
    title: '通用 mcpServers JSON',
    hint: '适用于 Antigravity（mcp_config.json）、Claude Desktop（claude_desktop_config.json）、Cursor（~/.cursor/mcp.json）、Cherry Studio 等：合并到配置文件的 mcpServers 字段。'
  },
  {
    key: 'claudeCodeCommand',
    title: 'Claude Code',
    hint: '在终端执行以下命令，注册为用户级 MCP 服务器。'
  },
  {
    key: 'codexToml',
    title: 'Codex',
    hint: '追加到 ~/.codex/config.toml。'
  }
];

export interface McpConnectionCardProps {
  desktop?: McpConnectionDesktop;
  active?: boolean;
  copyText?: (text: string) => Promise<void>;
  /** Pre-resolved snapshot (used for static rendering and tests). */
  initialInfo?: McpConnectionInfo;
  /** Initial transport tab (defaults to 'http' when httpConfigs is available, otherwise 'stdio'). */
  initialTransportTab?: McpTransportTab;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function maskMcpToken(token: string | null | undefined): string {
  if (!token) return '未生成';
  if (token.length <= 12) return '••••••••';
  return `${token.slice(0, 6)}••••••••${token.slice(-4)}`;
}

export default function McpConnectionCard({
  desktop,
  active = true,
  copyText = copyPlainText,
  initialInfo,
  initialTransportTab
}: McpConnectionCardProps) {
  const [info, setInfo] = useState<McpConnectionInfo | null>(initialInfo ?? null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [transportTab, setTransportTab] = useState<McpTransportTab>(
    initialTransportTab ?? (initialInfo && !initialInfo.httpConfigs ? 'stdio' : 'http')
  );
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const available = Boolean(desktop?.mcpConnectionInfo);

  const reload = useCallback(async () => {
    if (!desktop?.mcpConnectionInfo) return;
    try {
      const next = await desktop.mcpConnectionInfo();
      if (mounted.current) { setInfo(next); setError(''); }
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    }
  }, [desktop]);

  useEffect(() => {
    mounted.current = true;
    if (active) void reload();
    return () => { mounted.current = false; };
  }, [active, reload]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage(''); setError('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }

  if (!available) {
    return <div className="sy-settings-card" data-testid="mcp-connection-card">
      <h3>AI 协作 (MCP)</h3>
      <p>MCP 连接仅在桌面版中可用。</p>
    </div>;
  }

  const running = info?.running === true;
  const effectiveTransport: McpTransportTab = transportTab === 'http' && info?.httpConfigs ? 'http' : 'stdio';
  const activeConfigs = effectiveTransport === 'http' && info?.httpConfigs ? info.httpConfigs : info?.configs;

  return <div className="sy-settings-card sy-mcp-connection" data-testid="mcp-connection-card">
    <h3>AI 协作 (MCP)</h3>
    <p>外部 AI 智能体（Antigravity、Claude、Cursor、Codex、Cherry Studio 等）可通过标准 <strong>MCP HTTP / SSE 协议</strong>或 <strong>Stdio 协议</strong>直接操作当前工作台：导入结构、配置计算、管理任务中心与执行环境。</p>
    <div className="sy-settings-fields">
      <label>
        <input
          type="checkbox"
          checked={info?.enabled ?? false}
          disabled={busy || !info || !desktop?.setMcpConnectionEnabled}
          onChange={event => {
            const enabled = event.currentTarget.checked;
            void perform(async () => {
              const next = await desktop!.setMcpConnectionEnabled!(enabled);
              if (!mounted.current) return;
              setInfo(next);
              setMessage(enabled ? 'MCP 服务已启用' : 'MCP 服务已停用');
            });
          }}
        />
        启用 MCP 服务
      </label>
      <span role="status" data-testid="mcp-connection-state">
        {!info ? '读取中…' : running ? `运行中 · ${info.host}:${info.port} · PID ${info.pid}` : '未运行'}
      </span>
      <button
        type="button"
        disabled={busy || !running || !desktop?.testMcpConnection}
        onClick={() => void perform(async () => {
          const result = await desktop!.testMcpConnection!();
          if (!mounted.current) return;
          setInfo(result.info);
          if (result.ok) setMessage(result.workbenchOnline ? '连接正常：MCP 服务与工作台均在线' : '已连接 MCP 服务，但工作台前端暂未响应');
          else setError(`连接失败：${result.reason ?? '未知原因'}`);
        })}
      >测试连接</button>
      <button type="button" disabled={busy} onClick={() => void perform(reload)}>刷新</button>
    </div>

    {info && (info.httpUrl || info.token) && <div className="sy-mcp-credentials" data-testid="mcp-http-credentials">
      {info.httpUrl && <div className="sy-mcp-credential-row">
        <span className="sy-mcp-credential-label">HTTP 地址（Streamable HTTP）：</span>
        <code data-testid="mcp-http-url">{info.httpUrl}</code>
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(async () => {
            await copyText(info.httpUrl!);
            if (mounted.current) setMessage('已复制 MCP HTTP 地址');
          })}
        >复制地址</button>
      </div>}
      {info.sseUrl && <div className="sy-mcp-credential-row">
        <span className="sy-mcp-credential-label">SSE 地址（旧版 HTTP+SSE）：</span>
        <code data-testid="mcp-sse-url">{info.sseUrl}</code>
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(async () => {
            await copyText(info.sseUrl!);
            if (mounted.current) setMessage('已复制 MCP SSE 地址');
          })}
        >复制 SSE</button>
      </div>}
      {info.token && <div className="sy-mcp-credential-row">
        <span className="sy-mcp-credential-label">连接密钥（Bearer Token）：</span>
        <code data-testid="mcp-connection-token">{showToken ? info.token : maskMcpToken(info.token)}</code>
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowToken(prev => !prev)}
        >{showToken ? '隐藏密钥' : '显示密钥'}</button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(async () => {
            await copyText(info.token!);
            if (mounted.current) setMessage('已复制 MCP 连接密钥');
          })}
        >复制密钥</button>
        {desktop?.rotateMcpConnectionToken && <button
          type="button"
          disabled={busy}
          onClick={() => void perform(async () => {
            const next = await desktop.rotateMcpConnectionToken!();
            if (!mounted.current) return;
            setInfo(next);
            setMessage('已重置 MCP 连接密钥（已连接的 HTTP 客户端需更新密钥）');
          })}
        >重置密钥</button>}
      </div>}
      {info.httpUrlWithToken && info.httpUrl && <div className="sy-mcp-credential-row">
        <span className="sy-mcp-credential-label">免 Header 直连 URL（含密钥）：</span>
        <code data-testid="mcp-http-url-with-token">
          {showToken ? info.httpUrlWithToken : `${info.httpUrl}?token=${maskMcpToken(info.token)}`}
        </code>
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(async () => {
            await copyText(info.httpUrlWithToken!);
            if (mounted.current) setMessage('已复制带密钥的 MCP HTTP 直连地址');
          })}
        >复制带密钥 URL</button>
      </div>}
    </div>}

    {info && <p className="analysis-environment-path">会话文件：<code>{info.sessionFilePath}</code>{info.startedAt ? ` · 启动于 ${info.startedAt}` : ''}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}

    {info && info.httpConfigs && <div className="sy-mcp-transport-tabs" role="tablist" aria-label="MCP 连接协议">
      <button
        type="button"
        role="tab"
        aria-selected={effectiveTransport === 'http'}
        data-testid="mcp-tab-http"
        onClick={() => setTransportTab('http')}
      >HTTP 协议（推荐）</button>
      <button
        type="button"
        role="tab"
        aria-selected={effectiveTransport === 'stdio'}
        data-testid="mcp-tab-stdio"
        onClick={() => setTransportTab('stdio')}
      >Stdio 协议（免配置密钥）</button>
    </div>}

    {info && activeConfigs && MCP_CLIENT_SNIPPETS.map(snippet => <section key={snippet.key} className="sy-mcp-snippet" aria-label={snippet.title}>
      <h4>{snippet.title}</h4>
      <p>{snippet.hint}</p>
      <pre data-testid={`mcp-snippet-${snippet.key}`}>{activeConfigs[snippet.key]}</pre>
      <button
        type="button"
        disabled={busy}
        onClick={() => void perform(async () => {
          await copyText(activeConfigs[snippet.key]);
          if (mounted.current) setMessage(`已复制「${snippet.title}」配置`);
        })}
      >复制</button>
    </section>)}
    {info && !info.enabled && <p>提示：MCP 服务停用时，外部客户端会报告“桌面端未运行”。</p>}
  </div>;
}
