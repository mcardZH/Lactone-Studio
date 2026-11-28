import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ClipboardCopy, Download, ExternalLink, Grip, PanelBottom, PanelRight, TerminalSquare } from 'lucide-react';
import { copyPlainText } from '../clipboard-text';
import { useWorkbenchFloat } from '../useWorkbenchFloat';
import AgentAssistant from './AgentAssistant';
import { agentPanelError, readAgentPanelBridge, type AssistantAttachmentPort, type ExternalConnectionBridge, type ExternalConnectionState } from './agent-panel-bridge';
import { ES_MCP_SETUP_PROMPT } from './setup-prompt';
import './AgentPanel.css';

const AgentTerminal = lazy(() => import('./AgentTerminal'));
const tabs = { terminal: '终端', assistant: '内置助手', connections: 'MCP 连接' };
type Tab = keyof typeof tabs;
type Side = 'bottom' | 'right';
type Layout = { side: Side; width: number; height: number; expanded: boolean; tab: Tab };
type Gesture = { mode: 'dock' | 'resize'; side: Side; startX: number; startY: number; size: number; preferredSize: number; moved: boolean };

const defaults: Layout = { side: 'right', width: 350, height: 252, expanded: true, tab: 'terminal' };
const opposite = (side: Side): Side => side === 'right' ? 'bottom' : 'right';
const dockName = (side: Side) => side === 'right' ? '停靠右侧' : '停靠底部';
const inset = 72;
const layoutPreference = 'ester-agent-dock-layout-v1';

function readLayout(): Partial<Layout> | undefined {
  try { return JSON.parse(localStorage.getItem(layoutPreference) ?? 'null') ?? undefined; }
  catch { return undefined; }
}

function savedLayout(value?: Partial<Layout>): Layout {
  return {
    side: value?.side === 'bottom' || value?.side === 'right' ? value.side : defaults.side,
    width: Number.isFinite(value?.width) ? Math.max(288, value!.width!) : defaults.width,
    height: Number.isFinite(value?.height) ? Math.max(196, value!.height!) : defaults.height,
    expanded: value?.expanded !== false,
    tab: value?.tab === 'assistant' || value?.tab === 'connections' ? value.tab : 'terminal',
  };
}

function Connections({ bridge, state, prompt }: { bridge: ExternalConnectionBridge; state?: ExternalConnectionState; prompt: string }) {
  const [notice, setNotice] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [savingSkill, setSavingSkill] = useState(false);
  const promptBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (showPrompt) { promptBox.current?.focus(); promptBox.current?.select(); }
  }, [showPrompt]);

  async function copy() {
    try {
      await copyPlainText(prompt);
      setShowPrompt(false);
      setNotice('已复制');
    } catch {
      setShowPrompt(true);
      promptBox.current?.select();
      setNotice('请手动复制已选中的提示词');
    }
  }

  async function saveSkill() {
    if (!bridge.savePublicSkill || savingSkill) return;
    setSavingSkill(true);
    setNotice('');
    try {
      const result = await bridge.savePublicSkill();
      if (!result.cancelled) setNotice(`Skill 已保存至 ${result.path}`);
    } catch (error) {
      setNotice(agentPanelError(error));
    } finally {
      setSavingSkill(false);
    }
  }

  return <div className="es-agent-connections">
    <div className="es-dock-setup">
      <button type="button" className="es-agent-primary" onClick={() => void copy()}><ClipboardCopy size={15} aria-hidden="true" />复制配置提示词</button>
      <small>粘贴到你的 Agent，填写 ES 位置。首次连接时请在 ES 确认。</small>
      {bridge.savePublicSkill && <>
        <button type="button" className="es-dock-skill-save" disabled={savingSkill} onClick={() => void saveSkill()}><Download size={15} aria-hidden="true" />另存 Skill ZIP</button>
        <small>供外部 Agent 选装。解压后安装整个 ester-studio 文件夹。</small>
      </>}
      {notice && <span className="es-agent-notice" role="status">{notice}</span>}
      {showPrompt && <div className="es-agent-configuration">
        <textarea aria-label="通用 MCP 配置提示词" readOnly spellCheck={false} rows={5} ref={promptBox} value={prompt} />
        <button type="button" onClick={() => { setShowPrompt(false); setNotice(''); }}>收起提示词</button>
      </div>}
    </div>
    <section className="es-dock-online" aria-label="已连接的客户端">
      <strong>已连接</strong>
      {state?.connections.length ? <ul>{state.connections.map(connection => <li key={connection.id}>
        <span><i className="es-dock-connected" aria-hidden="true" />{connection.clientName}</span>
        <button type="button" aria-label={`断开 ${connection.clientName}`} onClick={() => {
          setNotice('');
          void bridge.disconnect(connection.id).catch(error => setNotice(agentPanelError(error)));
        }}>断开</button>
      </li>)}</ul> : <small>{state?.available === false ? 'MCP 服务暂不可用' : '暂无连接'}</small>}
    </section>
    {Boolean(state?.rememberedClients?.length) && <details className="es-dock-online">
      <summary>管理已记住的授权</summary>
      <ul>{state?.rememberedClients.map(client => <li key={client.id}>
        <span>{client.clientName}</span><button type="button" aria-label={`撤销 ${client.clientName} 的授权`} onClick={() => {
          setNotice('');
          void bridge.forget(client.id).then(() => setNotice(`已撤销 ${client.clientName} 的授权。`), error => setNotice(agentPanelError(error)));
        }}>撤销授权</button>
      </li>)}</ul>
    </details>}
  </div>;
}

export function AgentPanel({ children, onOpenImage }: {
  children: ReactNode;
  onOpenImage?: AssistantAttachmentPort;
}) {
  const desktop = readAgentPanelBridge();
  const agent = desktop?.mcpAgent;
  const external = desktop?.mcp;
  const id = useId();
  const layoutRoot = useRef<HTMLDivElement>(null);
  const currentGesture = useRef<Gesture | null>(null);
  const [layout, setLayout] = useState(() => savedLayout(readLayout()));
  const [rect, setRect] = useState({ width: 1000, height: 550 });
  const [gesture, setGesture] = useState<'dock' | 'resize' | null>(null);
  const [candidate, setCandidate] = useState<Side | null>(null);
  const [opened, setOpened] = useState<Partial<Record<Tab, boolean>>>({ [layout.tab]: true });
  const [externalState, setExternalState] = useState<ExternalConnectionState>();
  const [connectionError, setConnectionError] = useState('');
  const wide = rect.width >= 700;
  const side = wide ? layout.side : 'bottom';
  function dropSide(x: number, y: number): Side | null {
    const bounds = layoutRoot.current?.getBoundingClientRect();
    if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    if (wide && x >= bounds.right - inset) return 'right';
    return y >= bounds.bottom - inset ? 'bottom' : null;
  }
  const float = useWorkbenchFloat({
    kind: 'agent-tools', title: '终端和助手',
    canDock: ({ x, y }) => dropSide(x, y) !== null,
    onDock: point => {
      const target = point && dropSide(point.x, point.y);
      if (target) update({ side: target, expanded: true });
    },
  });
  const connected = externalState?.connections.length ?? 0;
  const panelExpanded = layout.expanded || float.floating;
  const dockExpanded = layout.expanded && !float.floating;
  const visible = (tab: Tab) => panelExpanded && layout.tab === tab;
  const room = (dock: Side) => dock === 'right' ? rect.width - 345 : Math.max(48, rect.height - 175);
  const clamp = (next: number, dock = side) => Math.min(Math.max(dock === 'right' ? 288 : 196, next), room(dock));
  const size = clamp(side === 'right' ? layout.width : layout.height);

  useEffect(() => {
    const node = layoutRoot.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setRect({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!external) return;
    let live = true;
    let changed = false;
    const unsubscribe = external.onState(state => { changed = true; setExternalState(state); setConnectionError(''); });
    void external.state().then(state => { if (live && !changed) setExternalState(state); })
      .catch(error => { if (live && !changed) setConnectionError(agentPanelError(error)); });
    return () => { live = false; unsubscribe(); };
  }, [external]);

  function update(next: Partial<Layout>, remember = true) {
    const updated = { ...layout, ...next };
    setLayout(updated);
    if (remember) {
      try { localStorage.setItem(layoutPreference, JSON.stringify(updated)); } catch { /* The current window keeps the layout. */ }
    }
  }

  function activate(tab: Tab) {
    setOpened(previous => ({ ...previous, [tab]: true }));
    update({ tab, expanded: true });
  }

  function begin(event: PointerEvent<HTMLElement>, mode: Gesture['mode']) {
    if (event.button !== 0) return;
    currentGesture.current = { mode, side, size, preferredSize: side === 'right' ? layout.width : layout.height, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = currentGesture.current;
    if (!active || !layoutRoot.current) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < 5) return;
    active.moved = true;
    setGesture(active.mode);
    if (active.mode === 'resize') {
      const next = clamp(active.size - (active.side === 'right' ? dx : dy), active.side);
      update(active.side === 'right' ? { width: next } : { height: next }, false);
      return;
    }
    setCandidate(dropSide(event.clientX, event.clientY));
  }

  function finish(event: PointerEvent<HTMLElement>) {
    const active = currentGesture.current;
    currentGesture.current = null;
    setGesture(null);
    setCandidate(null);
    if (!active?.moved) return;
    if (active.mode === 'dock') {
      if (event.type !== 'pointerup') return;
      const target = dropSide(event.clientX, event.clientY);
      if (target) update({ side: target, expanded: true });
      else if (float.available) {
        const bounds = layoutRoot.current?.getBoundingClientRect();
        if (bounds && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
          void float.detach({ x: event.screenX, y: event.screenY });
        }
      }
    } else {
      const delta = active.side === 'right' ? event.clientX - active.startX : event.clientY - active.startY;
      const released = event.type === 'pointerup';
      const next = released ? clamp(active.size - delta, active.side) : active.preferredSize;
      update(active.side === 'right' ? { width: next } : { height: next }, released);
    }
  }

  const pointer = { onPointerMove: move, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish };
  const DockIcon = side === 'right' ? PanelBottom : PanelRight;
  const FoldIcon = side === 'right' ? ChevronRight : layout.expanded ? ChevronUp : ChevronDown;
  const grip = <div className="es-dock-grab" data-testid="dock-grip" onPointerDown={event => begin(event, 'dock')} {...pointer}>
    <Grip size={15} aria-hidden="true" /><span>终端和助手</span>
  </div>;

  if (!agent) return <>{children}</>;

  const floatingSide = float.dragPoint && dropSide(float.dragPoint.x, float.dragPoint.y);
  const highlighted = floatingSide || candidate;
  return <div ref={layoutRoot} className="es-dock-layout" data-dock={side} data-expanded={dockExpanded} data-gesture={gesture ?? ''}
    style={{ '--es-dock-size': `${size}px` } as CSSProperties}>
    <div className="es-dock-model">{children}</div>
    {dockExpanded && <button type="button" role="separator" className="es-dock-split" data-testid="dock-split"
      aria-label={side === 'right' ? '调整面板宽度' : '调整面板高度'} aria-orientation={side === 'right' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(size)} aria-valuemin={Math.min(side === 'right' ? 288 : 196, Math.round(room(side)))} aria-valuemax={Math.round(room(side))}
      onPointerDown={event => begin(event, 'resize')} {...pointer}
      onKeyDown={event => {
        const grow = side === 'right' ? 'ArrowLeft' : 'ArrowUp';
        const shrink = side === 'right' ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== grow && event.key !== shrink) return;
        event.preventDefault();
        const resized = clamp(size + (event.key === grow ? 16 : -16));
        update(side === 'right' ? { width: resized } : { height: resized });
      }} />}
    <div className="es-agent-slot" ref={float.slotRef}/>
    {float.floating && <section className="es-agent-dock" aria-label="终端和助手独立窗口">
      <header className="es-agent-header">
        <button type="button" className="es-dock-rail" aria-label="定位终端和助手独立窗口" onClick={float.focus}>
          <ExternalLink size={16} aria-hidden="true" /><span>终端和助手</span>
        </button>
      </header>
    </section>}
    {float.render(<section className="es-agent-dock" aria-label="终端和助手">
      {!float.floating && <header className="es-agent-header">
        {side === 'right' && !layout.expanded ? <button type="button" className="es-dock-rail" aria-label="展开右侧终端和助手" onClick={() => update({ expanded: true })}>
          <TerminalSquare size={16} aria-hidden="true" /><span>终端和助手</span><ChevronLeft size={15} aria-hidden="true" />
        </button> : <>
          {grip}
          <div className="es-dock-header-actions">
            {wide && <button type="button" aria-label={dockName(opposite(side))} data-tooltip={dockName(opposite(side))} onClick={() => update({ side: opposite(side), expanded: true })}><DockIcon size={16} aria-hidden="true" /></button>}
            {float.available && <button type="button" aria-label="浮出终端和助手" data-tooltip="浮出终端和助手" onClick={() => void float.detach()}><ExternalLink size={16} aria-hidden="true" /></button>}
            <button type="button" aria-expanded={layout.expanded} aria-controls={`${id}-tools`} aria-label={layout.expanded ? '折叠终端和助手' : '展开终端和助手'}
              onClick={() => update({ expanded: !layout.expanded })}><FoldIcon size={17} aria-hidden="true" /></button>
          </div>
        </>}
      </header>}
      {float.error && <p className="es-agent-float-notice" role="status">{float.error}</p>}
      <div className="es-agent-panel" id={`${id}-tools`} hidden={!panelExpanded}>
        <div className="es-agent-tabs" role="tablist" aria-label="终端和助手页面">
          {(Object.keys(tabs) as Tab[]).map(tab => <button type="button" key={tab} role="tab" id={`${id}-${tab}`} aria-controls={`${id}-${tab}-pane`}
            tabIndex={layout.tab === tab ? 0 : -1} aria-selected={layout.tab === tab} onClick={() => activate(tab)} onKeyDown={event => {
              const order = Object.keys(tabs) as Tab[];
              const here = order.indexOf(tab);
              const next = event.key === 'Home' ? order[0] : event.key === 'End' ? order.at(-1)
                : event.key === 'ArrowLeft' ? order.at(here - 1) : event.key === 'ArrowRight' ? order[(here + 1) % order.length] : undefined;
              if (!next) return;
              event.preventDefault(); activate(next); event.currentTarget.ownerDocument.getElementById(`${id}-${next}`)?.focus();
            }}>{tabs[tab]}{tab === 'connections' && connected > 0 && <span className="es-dock-count" aria-label={`${connected} 个连接`}>{connected}</span>}</button>)}
        </div>
        <div className="es-agent-pane" id={`${id}-terminal-pane`} role="tabpanel" aria-labelledby={`${id}-terminal`} hidden={!visible('terminal')}>
          {opened.terminal && <Suspense fallback={<span>正在加载终端…</span>}><AgentTerminal bridge={agent} visible={visible('terminal')} floating={float.floating} /></Suspense>}
        </div>
        <div className="es-agent-pane" id={`${id}-assistant-pane`} role="tabpanel" aria-labelledby={`${id}-assistant`} hidden={!visible('assistant')}>
          {opened.assistant && <AgentAssistant bridge={agent} onOpenImage={onOpenImage} floating={float.floating} />}
        </div>
        <div className="es-agent-pane" id={`${id}-connections-pane`} role="tabpanel" aria-labelledby={`${id}-connections`} hidden={!visible('connections')}>
          {external && <Connections bridge={external} state={externalState} prompt={ES_MCP_SETUP_PROMPT} />}
          {connectionError && <p role="status">{connectionError}</p>}
        </div>
      </div>
    </section>)}
    {(gesture === 'dock' || floatingSide) && <div className="es-dock-targets" aria-hidden="true">
      {wide && <div className="es-dock-target es-dock-target-right" data-active={highlighted === 'right'}>{highlighted === 'right' ? '松开停靠右侧' : '右侧'}</div>}
      <div className="es-dock-target es-dock-target-bottom" data-active={highlighted === 'bottom'}>{highlighted === 'bottom' ? '松开停靠底部' : '底部'}</div>
    </div>}
  </div>;
}
