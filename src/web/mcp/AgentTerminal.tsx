import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { copyPlainText } from '../clipboard-text';
import { agentPanelError, type AgentPanelBridge, type TerminalClient } from './agent-panel-bridge';

const isMacPlatform = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
const isWindowsPlatform = () => typeof navigator !== 'undefined' && /win/i.test(navigator.platform || '');

export default function AgentTerminal({ bridge, visible, floating }: { bridge: AgentPanelBridge; visible: boolean; floating: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const emulation = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);
  const currentId = useRef<string | null>(null);
  const windowsHost = isWindowsPlatform();
  const [client, setClient] = useState<TerminalClient>(windowsHost ? 'powershell' : 'shell');
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'stopping'>('idle');
  const [notice, setNotice] = useState('');

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Cascadia Mono', Consolas, 'PingFang SC', 'Microsoft YaHei', monospace",
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize) || 13,
      lineHeight: 1.24,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    emulation.current = { terminal, fit };
    const report = (error: unknown) => setNotice(agentPanelError(error));
    const unsubscribe = bridge.onTerminalEvent(event => {
      if (event.id !== currentId.current) return;
      if (event.type === 'data') terminal.write(event.data);
      else {
        currentId.current = null;
        terminal.options.disableStdin = true;
        setPhase('idle');
        const exit = event.exitCode ?? event.signal;
        setNotice(event.warning ?? (exit == null ? '终端已关闭。' : `终端已关闭（退出状态 ${exit}）。`));
      }
    });
    const data = terminal.onData(input => {
      const id = currentId.current;
      if (id) void bridge.terminalWrite(id, input).catch(report);
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      const id = currentId.current;
      if (id) void bridge.terminalResize(id, cols, rows).catch(report);
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      const copyShortcut = (event.ctrlKey && event.shiftKey) || (isMacPlatform() && event.metaKey && !event.ctrlKey && !event.altKey);
      if (!copyShortcut) return true;
      if (event.code === 'KeyC' && terminal.hasSelection()) {
        void copyPlainText(terminal.getSelection()).catch(report);
        return false;
      }
      if (event.code === 'KeyV' && navigator.clipboard?.readText) {
        void navigator.clipboard.readText().then(text => terminal.paste(text)).catch(report);
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(() => { if (element.clientWidth && element.clientHeight) fit.fit(); });
    observer.observe(element);
    terminal.options.disableStdin = true;
    return () => {
      observer.disconnect();
      unsubscribe();
      data.dispose();
      resize.dispose();
      terminal.dispose();
      emulation.current = null;
      const id = currentId.current;
      currentId.current = null;
      if (id) void bridge.terminalStop(id).catch(() => undefined);
    };
  }, [bridge]);

  useLayoutEffect(() => {
    const element = container.current;
    const engine = emulation.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !engine || !view) return;
    const { terminal, fit } = engine;
    // Rebind xterm's display to the adopted DOM window using the same emulator and PTY.
    terminal.open(element);
    const syncTheme = () => {
      const surface = view.getComputedStyle(element);
      terminal.options.theme = {
        background: surface.backgroundColor,
        foreground: surface.color,
        cursor: surface.getPropertyValue('--ui-control-accent').trim(),
        selectionBackground: surface.getPropertyValue('--ui-control-selected-bg').trim(),
      };
      const size = Number.parseFloat(surface.fontSize);
      if (size > 0 && terminal.options.fontSize !== size) terminal.options.fontSize = size;
      if (element.clientWidth && element.clientHeight) fit.fit();
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(element.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-interface-theme', 'data-font-size', 'style'] });
    return () => observer.disconnect();
  }, [bridge, floating]);

  useEffect(() => { if (visible) emulation.current?.fit.fit(); }, [visible]);

  async function start() {
    const engine = emulation.current;
    if (!engine || currentId.current) return;
    engine.terminal.reset();
    engine.fit.fit();
    const { cols, rows } = engine.terminal;
    const id = crypto.randomUUID();
    currentId.current = id;
    setPhase('starting');
    setNotice('');
    try {
      await bridge.terminalStart({ id, cols, rows, client });
      if (id !== currentId.current) return;
      engine.terminal.options.disableStdin = false;
      setPhase('running');
      if (container.current?.getClientRects().length) engine.terminal.focus();
    } catch (cause) {
      if (id !== currentId.current) return;
      currentId.current = null;
      setPhase('idle');
      setNotice(agentPanelError(cause));
    }
  }

  async function stop() {
    const id = currentId.current;
    if (!id) return;
    setPhase('stopping');
    try { await bridge.terminalStop(id); }
    catch (cause) { setPhase('running'); setNotice(agentPanelError(cause)); }
  }

  return <div className="es-agent-terminal">
    <div className="es-agent-tools">
      <label className="es-agent-inline"><select aria-label="终端类型" value={client} disabled={phase !== 'idle'} onChange={event => setClient(event.target.value as TerminalClient)}>
        <option value={windowsHost ? 'powershell' : 'shell'}>{windowsHost ? 'PowerShell' : isMacPlatform() ? 'Shell (zsh)' : 'Shell (bash)'}</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="dsh">dsh</option>
      </select></label>
      {phase === 'idle' || phase === 'starting'
        ? <button type="button" disabled={phase === 'starting'} onClick={() => void start()}>{phase === 'starting' ? '正在启动…' : '打开终端'}</button>
        : <button type="button" disabled={phase === 'stopping'} onClick={() => void stop()}>{phase === 'stopping' ? '正在关闭…' : '关闭终端'}</button>}
      {notice && <span className="es-agent-notice" role="status">{notice}<button type="button" aria-label="关闭终端提示" onClick={() => setNotice('')}>×</button></span>}
      {phase === 'running' && <small className="es-dock-terminal-status"><i className="es-dock-connected" aria-hidden="true" />运行中</small>}
      {phase === 'running' && <small className="es-agent-terminal-commands"><code>es-codex</code> · <code>es-claude</code> · <code>es-dsh</code></small>}
    </div>
    <div className="es-agent-terminal-screen" aria-label="终端输出" ref={container} onKeyDown={event => event.stopPropagation()} />
  </div>;
}
