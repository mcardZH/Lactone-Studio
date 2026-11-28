import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, Paperclip, Send, Square, X } from 'lucide-react';
import fromMarkdown from 'mdast-util-from-markdown';
import { copyPlainText } from '../clipboard-text';
import { twoDImageMime } from '../../modeling/two-d/static-image';
import { decodeStaticImage } from '../../modeling/two-d/static-image-decode';
import { agentPanelError, type AgentPanelBridge, type AssistantAttachmentPort, type AssistantAttachmentReceipt,
  type AssistantEvent, type AssistantMessage, type AssistantModel, type AssistantPhase, type AssistantProfile,
  type AssistantProtocol, type AssistantProvider, type AssistantSettings, type AssistantTurnReceipt } from './agent-panel-bridge';

const providerNames: Record<AssistantProvider, string> = {
  deepseek: 'DeepSeek', openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini',
  ollama: 'Ollama', kimi: 'Kimi 开放平台', glm: 'GLM', custom: '自定义 (Custom)',
};
const protocolNames: Record<AssistantProtocol, string> = {
  chat: 'Chat Completions', responses: 'Responses', messages: 'Messages',
};
const avatar = import.meta.env.BASE_URL + 'favicon.svg';
const imageFormat = /\.(?:png|jpe?g|bmp|tiff?|webp|gif)$/i;
const imageMime = /^image\/(?:png|jpeg|bmp|x-ms-bmp|tiff|webp|gif)$/i;
const statusText = { queued: '排队中', running: '处理中', guiding: '等待引导', guided: '已引导当前轮', stopped: '已暂停', returned: '已处理', error: '待继续', unsent: '未发送' };
const activityText: Record<Exclude<AssistantPhase, 'idle'>, string> = {
  model: '模型响应中', tool: '工具执行中', waiting: '等待中', stopping: '正在停止', paused: '已暂停',
};
type MessageStatus = keyof typeof statusText;
type Attachment = { id: string; file: File; url: string };
type Draft = { id: string; replayOf?: string; text: string; files: Attachment[] };
type Activity = Extract<AssistantEvent, { type: 'activity' }>;
type Effort = Extract<AssistantEvent, { type: 'reasoning-effort' }>;
type Reply = Extract<AssistantEvent, { type: 'assistant' | 'reasoning' | 'tool' | 'notice' }>;
type UserEntry = { type: 'user'; id: string; draft: Draft; status: MessageStatus; guidedTurnId?: string };
type Entry = Reply | UserEntry;
type Active = { draft: Draft; controller: AbortController; host: boolean; stopping: boolean };
type Paused = { draft: Draft; host: boolean };
type MarkdownNode = ReturnType<typeof fromMarkdown>['children'][number];

function recognitionFacts(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const fields = value as Record<string, unknown>;
  const keys = ['state', 'status', 'phase', 'sourceId', 'imageId', 'draftRevision', 'revision', 'candidateCount', 'width', 'height', 'available', 'reason', 'error'];
  return Object.fromEntries(keys.flatMap(key => {
    const v = fields[key];
    return ['string', 'number', 'boolean'].includes(typeof v) ? [[key, v]] : [];
  }));
}

async function prepareImage(file: File, signal: AbortSignal) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const mime = twoDImageMime(bytes);
  if (!mime) throw new Error('无法识别图片内容，请检查原文件。');
  if (mime !== 'image/tiff' && mime !== 'image/bmp') return bytes;
  const { canvas } = await decodeStaticImage(bytes, signal);
  try {
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成供模型读取的 PNG。')), 'image/png');
    });
    signal.throwIfAborted();
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function sendProblem(profile: AssistantProfile | undefined, hasImages: boolean) {
  if (!isConfigured(profile)) return '请先配置模型服务。';
  if (hasImages && profile?.vision === false) return '当前模型不支持图片。请更换模型或移除附件。';
}

function isConfigured(profile?: AssistantProfile) {
  return Boolean(profile?.model.trim() && (profile.hasKey || profile.keyRequired === false));
}

function capabilityText(value?: boolean) {
  return typeof value !== 'boolean' ? '未知' : value ? '支持' : '不支持';
}

function effortText(value?: string) {
  switch (value) {
    case undefined: case '': case 'default': return '服务默认';
    case 'none': case 'off': case 'disabled': return '关闭';
    case 'minimal': return '极低';
    case 'low': return '低';
    case 'medium': return '中';
    case 'high': return '高';
    case 'xhigh': return '极高';
    case 'max': case 'maximal': return '最高';
    default: return value;
  }
}

function turnEnd(entries: Entry[], turnId: string) {
  const start = entries.findIndex(entry => entry.type === 'user' && entry.id === turnId && !entry.guidedTurnId);
  if (start < 0) return -1;
  let end = start + 1;
  for (; end < entries.length; end++) {
    const entry = entries[end];
    if (entry.type === 'user' && entry.guidedTurnId !== turnId) break;
  }
  return end;
}

function CodeBlock({ lang, value }: { lang?: string | null; value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);
  const handleCopy = () => {
    void copyPlainText(value).then(() => {
      setCopied(true);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return <div className="es-agent-codeblock">
    <div className="es-agent-codeblock-header">
      <span className="es-agent-codeblock-lang">{lang?.trim() || 'text'}</span>
      <button type="button" className="es-agent-codeblock-copy" aria-label="复制代码" onClick={handleCopy}>
        {copied ? <><Check size={12} aria-hidden="true" />已复制</> : <><Copy size={12} aria-hidden="true" />复制</>}
      </button>
    </div>
    <pre><code>{value}</code></pre>
  </div>;
}

function AnswerMarkdown({ text }: { text: string }) {
  try {
    const tree = fromMarkdown(text);
    const definitions = new Map<string, string>();
    for (const node of tree.children) {
      if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    }
    // Answer content is model output. Emit only React text and allowlisted elements.
    // Keep link targets copyable and avoid external resource loads in the workspace.
    const children = (nodes: MarkdownNode[]): ReactNode => nodes.map((node, index) =>
      <Fragment key={node.position?.start.offset ?? index}>{render(node)}</Fragment>);
    function render(node: MarkdownNode): ReactNode {
      switch (node.type) {
        case 'text': case 'html': return node.value;
        case 'paragraph': return <p>{children(node.children)}</p>;
        case 'heading': {
          const Heading = `h${node.depth}` as const;
          return <Heading>{children(node.children)}</Heading>;
        }
        case 'strong': return <strong>{children(node.children)}</strong>;
        case 'emphasis': return <em>{children(node.children)}</em>;
        case 'inlineCode': return <code>{node.value}</code>;
        case 'code': return <CodeBlock lang={node.lang} value={node.value} />;
        case 'list': return node.ordered ? <ol start={node.start ?? undefined}>{children(node.children)}</ol> : <ul>{children(node.children)}</ul>;
        case 'listItem': return <li>{children(node.children)}</li>;
        case 'blockquote': return <blockquote>{children(node.children)}</blockquote>;
        case 'thematicBreak': return <hr />;
        case 'break': return <br />;
        case 'link': return <>{children(node.children)}{node.children[0]?.type === 'text' && node.children[0].value === node.url ? null : ` (${node.url})`}</>;
        case 'linkReference': {
          const url = definitions.get(node.identifier);
          return <>{children(node.children)}{url && ` (${url})`}</>;
        }
        case 'image': case 'imageReference': return node.alt;
        default: return null;
      }
    }
    return children(tree.children);
  } catch {
    return text;
  }
}

function ReceiptDetail({ event }: { event: Extract<Reply, { type: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const summary = <><code>{event.name}</code> · {event.status === 'running' ? '执行中' : event.status === 'returned' ? '已返回' : '操作未完成'}
    {event.reused && ' · 已核对原回执'}{event.text && <span className="es-agent-tool-error">{event.text}</span>}</>;
  if (event.arguments === undefined && event.receipt === undefined) return <span>{summary}</span>;
  return <details onToggle={toggle => setExpanded(toggle.currentTarget.open)}>
    <summary>{summary}</summary>
    {expanded && event.arguments !== undefined && <div className="es-agent-tool-detail">
      <small>调用参数</small>
      <pre data-testid="es-agent-tool-arguments">{event.arguments}</pre>
    </div>}
    {expanded && event.receipt !== undefined && <div className="es-agent-tool-detail">
      <small>执行回执</small>
      <pre data-testid="es-agent-tool-receipt">{JSON.stringify(event.receipt, null, 2)}</pre>
    </div>}
  </details>;
}

function ReasoningDetail({ event, turnActive }: { event: Extract<Reply, { type: 'reasoning' }>; turnActive: boolean }) {
  const [open, setOpen] = useState(false);
  const working = turnActive && event.active;
  return <details className="es-agent-reasoning" onToggle={toggle => setOpen(toggle.currentTarget.open)}>
    <summary>{working
      ? <span className="es-agent-activity"><i aria-hidden="true" />{event.summary ? '思考中 · 推理摘要' : '思考中'}</span>
      : event.summary ? '推理摘要' : '思考'}</summary>
    {open && <div data-testid="es-agent-reasoning-text">{event.text}</div>}
  </details>;
}

export const ReplyRow = memo(function ReplyRow({ entry, turnActive }: { entry: Reply; turnActive: boolean }) {
  return <div className={'es-agent-reply es-agent-reply-' + entry.type}>
    {entry.type === 'assistant' && <img className="es-agent-avatar" src={avatar} alt="Lactone Studio" />}
    <div className={'es-agent-entry es-agent-entry-' + entry.type}>
      {entry.type === 'assistant' && <div className="es-agent-answer" data-testid="es-agent-assistant-text"><AnswerMarkdown text={entry.text} /></div>}
      {entry.type === 'reasoning' && <ReasoningDetail event={entry} turnActive={turnActive} />}
      {entry.type === 'tool' && <ReceiptDetail event={entry} />}
      {entry.type === 'notice' && entry.text}
    </div>
  </div>;
});

function scrollToLatest(node: HTMLDivElement | null, follow: boolean) {
  if (!node || !follow || node.closest('[hidden]') || node.ownerDocument.hidden) return;
  node.scrollTop = node.scrollHeight;
}

export default function AgentAssistant({
  bridge,
  onOpenImage,
  floating,
  initialSettings,
  initialConfiguredOpen = false,
}: {
  bridge: AgentPanelBridge;
  onOpenImage?: AssistantAttachmentPort;
  floating?: boolean;
  initialSettings?: AssistantSettings;
  initialConfiguredOpen?: boolean;
}) {
  const [settings, setSettings] = useState<AssistantSettings | undefined>(initialSettings);
  const [configuredOpen, setConfiguredOpen] = useState(initialConfiguredOpen);
  const [provider, setProvider] = useState<AssistantProvider>('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState<AssistantProtocol>('responses');
  const [effortDraft, setEffortDraft] = useState<{ connection: string; value: string }>();
  const [models, setModels] = useState<AssistantModel[]>();
  const [modelListAddress, setModelListAddress] = useState<string>();
  const [loadingModels, setLoadingModels] = useState(false);
  const modelRequest = useRef(0);
  const [custom, setCustom] = useState('');
  const [pending, setPending] = useState(false);
  const [savingCustom, setSavingCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [nativeImages, setNativeImages] = useState(new Map<string, AssistantAttachmentReceipt>());
  const [openingImage, setOpeningImage] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activity, setActivity] = useState<Activity>();
  const [turnEffort, setTurnEffort] = useState<Effort>();
  const log = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const queue = useRef<Draft[]>([]);
  const active = useRef<Active | null>(null);
  const interrupted = useRef<Paused | null>(null);
  const guides = useRef(new Map<string, { draft: Draft; controller: AbortController }>());
  const requestingGuidance = useRef(0);
  const previews = useRef(new Set<string>());
  const composing = useRef(false);
  const live = useRef(false);
  const nativeOpening = useRef<AbortController | null>(null);
  const latestNativeImages = useRef(nativeImages);
  const latestSettings = useRef(settings);
  const latestAttachments = useRef(attachments);
  latestNativeImages.current = nativeImages;
  latestSettings.current = settings;
  latestAttachments.current = attachments;
  const visibleSettings = settings?.profiles[settings.provider];
  const editedSettings = settings?.profiles[provider];
  const savedModel = model.trim() === editedSettings?.model && baseUrl === editedSettings.baseUrl && protocol === editedSettings.protocol
    ? editedSettings : undefined;
  const listedModel = models?.find(item => item.id === model.trim());
  const selectedModel = listedModel ? { ...savedModel, ...listedModel, ...listedModel.modelCapabilities } : savedModel;
  const effortConnection = JSON.stringify([provider, baseUrl.trim(), protocol, model.trim()]);
  const editedEffort = effortDraft?.connection === effortConnection ? effortDraft.value : undefined;
  const effortLevels = [...new Set(selectedModel?.reasoningLevels)].filter(level => level && level !== 'default');
  const preferredEffort = editedEffort ?? savedModel?.reasoningEffort;
  const selectedEffort = preferredEffort && effortLevels.includes(preferredEffort) ? preferredEffort : 'default';
  const showTurnEffort = Boolean(turnEffort);
  const requestedEffort = showTurnEffort ? turnEffort?.requested : visibleSettings?.reasoningEffort;
  const actualEffort = showTurnEffort ? turnEffort?.actual : undefined;
  const explicitEffort = Boolean(requestedEffort && requestedEffort !== 'default');
  const effortLabel = explicitEffort
    ? `${showTurnEffort ? '请求' : '已选'} ${effortText(requestedEffort)}`
    : '服务默认';
  const assistantReady = isConfigured(visibleSettings);
  const phase = stopping ? 'stopping' : activity?.phase;
  const phaseTurnId = stopping ? active.current?.draft.id : activity?.turnId;

  function clearModelList() {
    ++modelRequest.current;
    setModels(undefined);
    setModelListAddress(undefined);
    setLoadingModels(false);
  }

  function loadDraft(next: AssistantSettings, selected = next.provider) {
    const profile = next.profiles[selected];
    setProvider(selected);
    setModel(profile.model);
    setApiKey('');
    setRemember(next.canRemember && (profile.remembered || !profile.hasKey));
    setBaseUrl(profile.baseUrl);
    setProtocol(profile.protocol);
    setEffortDraft(undefined);
    clearModelList();
  }
  function setUser(draft: Draft, status: MessageStatus) {
    const settled = status === 'returned' || status === 'stopped' || status === 'error' || status === 'unsent';
    setEntries(previous => previous.map(entry => {
      if (entry.type === 'user' && entry.id === draft.id) return { ...entry, status };
      if (settled && entry.type === 'reasoning' && entry.turnId === draft.id && entry.active) return { ...entry, active: false };
      return entry;
    }));
  }
  function addReply(reply: Reply) {
    setEntries(previous => {
      const target = reply.id ? previous.findIndex(entry => entry.type === reply.type && entry.id === reply.id) : -1;
      if (target >= 0) {
        const entry = previous[target];
        if (entry.type === 'user') return previous;
        const turnId = reply.turnId ?? entry.turnId;
        const next = previous.slice();
        next[target] = entry.type === 'tool' && reply.type === 'tool'
          ? { ...entry, ...reply, turnId, arguments: reply.arguments ?? entry.arguments }
          : { ...entry, ...reply, turnId } as Entry;
        return next;
      }
      if (!reply.turnId) return [...previous, reply];
      const end = turnEnd(previous, reply.turnId);
      if (end < 0) return previous;
      return [...previous.slice(0, end), reply, ...previous.slice(end)];
    });
  }

  function consumeGuide(turnId: string, id: string) {
    guides.current.delete(id);
    queue.current = queue.current.filter(draft => draft.id !== id);
    setEntries(previous => {
      const guide = previous.find(entry => entry.type === 'user' && entry.id === id);
      if (!guide || guide.type !== 'user' || guide.guidedTurnId) return previous;
      const remaining = previous.filter(entry => entry !== guide);
      const end = turnEnd(remaining, turnId);
      if (end < 0) return previous;
      return [...remaining.slice(0, end), { ...guide, status: 'guided', guidedTurnId: turnId }, ...remaining.slice(end)];
    });
  }

  async function outbound(draft: Draft, signal: AbortSignal): Promise<AssistantMessage> {
    const current = latestSettings.current;
    const problem = sendProblem(current?.profiles[current.provider], draft.files.length > 0);
    if (problem) throw new Error(problem);
    const images = [];
    for (const { file } of draft.files) {
      signal.throwIfAborted();
      try {
        images.push({ name: file.name, bytes: await prepareImage(file, signal) });
      } catch (cause) {
        signal.throwIfAborted();
        throw new Error(`${file.name}：${agentPanelError(cause)}`);
      }
    }
    signal.throwIfAborted();
    const opened = draft.files.flatMap(({ id }) => {
      const facts = latestNativeImages.current.get(id);
      return facts?.documentId ? [facts] : [];
    });
    return { id: draft.id, replayOf: draft.replayOf, text: draft.text, images, attachments: opened };
  }

  async function openNativeImage({ id, file }: Attachment) {
    if (!onOpenImage || nativeOpening.current) return;
    const opening = new AbortController();
    nativeOpening.current = opening;
    setOpeningImage(id);
    const remember = (facts: AssistantAttachmentReceipt) => {
      if (live.current && !opening.signal.aborted) setNativeImages(previous => new Map(previous).set(id, facts));
    };
    try {
      const received = await onOpenImage(file, opening.signal);
      remember({ name: file.name, documentId: received.documentId, recognition: recognitionFacts(received.recognition) });
    } catch (cause) {
      remember({ name: file.name, error: agentPanelError(cause) });
    } finally {
      if (nativeOpening.current === opening) {
        nativeOpening.current = null;
        if (live.current) setOpeningImage(undefined);
      }
    }
  }

  useEffect(() => {
    let mounted = true;
    live.current = true;
    const unsubscribe = bridge.onAssistantEvent(event => {
      if (event.type === 'activity') {
        if (active.current?.draft.id === event.turnId) {
          setActivity(previous => previous?.phase === event.phase && previous.turnId === event.turnId ? previous : event);
        }
        return;
      }
      if (event.type === 'reasoning-effort') {
        if (active.current?.draft.id === event.turnId) {
          setTurnEffort(previous => previous?.turnId === event.turnId ? { ...previous, ...event } : event);
        }
        return;
      }
      if (event.type === 'guide-consumed') { consumeGuide(event.turnId, event.id); return; }
      if (event.type === 'guide-rejected') {
        const guide = guides.current.get(event.id);
        if (!guide) return;
        guides.current.delete(event.id);
        setUser(guide.draft, 'unsent');
        addReply({ type: 'notice', id: event.id + '/unsent', turnId: event.id, text: event.text });
        return;
      }
      if (event.type !== 'guide-images') { addReply(event); return; }
      const guide = guides.current.get(event.id);
      if (!guide) return;
      void (async () => {
        try {
          const { images, attachments } = await outbound(guide.draft, guide.controller.signal);
          await bridge.assistantGuideImages(event.id, { images, attachments });
        } catch (cause) {
          if (mounted && !guide.controller.signal.aborted) {
            await bridge.assistantGuideImages(event.id, { error: agentPanelError(cause) }).catch(error => {
              if (mounted) setNotice(agentPanelError(error));
            });
          }
        }
      })();
    });
    void bridge.assistantSettings().then(next => {
      if (!mounted) return;
      setSettings(next);
      loadDraft(next);
      setCustom(next.customInstructions ?? '');
      setConfiguredOpen(!isConfigured(next.profiles[next.provider]));
    }).catch(cause => { if (mounted) setNotice(agentPanelError(cause)); });
    return () => {
      live.current = false;
      mounted = false;
      unsubscribe();
      active.current?.controller.abort();
      nativeOpening.current?.abort();
      for (const guide of guides.current.values()) guide.controller.abort();
      for (const url of previews.current) URL.revokeObjectURL(url);
      previews.current.clear();
    };
  }, [bridge]);

  useLayoutEffect(() => { scrollToLatest(log.current, followLatest.current); }, [entries]);
  useEffect(() => {
    const node = log.current;
    if (!node) return;
    const logDocument = node.ownerDocument;
    const onVisible = () => scrollToLatest(node, followLatest.current);
    const size = new ResizeObserver(onVisible);
    size.observe(node);
    logDocument.addEventListener('visibilitychange', onVisible);
    return () => {
      size.disconnect();
      logDocument.removeEventListener('visibilitychange', onVisible);
    };
  }, [floating]);

  function clearConversation(keepComposer = true) {
    for (const guide of guides.current.values()) guide.controller.abort();
    guides.current.clear();
    const kept = new Set(keepComposer ? latestAttachments.current.map(row => row.url) : []);
    for (const url of previews.current) {
      if (kept.has(url)) continue;
      URL.revokeObjectURL(url);
      previews.current.delete(url);
    }
    nativeOpening.current?.abort();
    const keptIds = new Set(keepComposer ? latestAttachments.current.map(row => row.id) : []);
    setNativeImages(previous => new Map([...previous].filter(([id]) => keptIds.has(id))));
    queue.current = [];
    interrupted.current = null;
    setPaused(false);
    setActivity(undefined);
    setTurnEffort(undefined);
    followLatest.current = true;
    setEntries([]);
    if (!keepComposer) { setAttachments([]); setMessage(''); }
  }

  function connectionDraft() {
    return { provider, baseUrl: baseUrl.trim(), protocol, apiKey: apiKey || undefined };
  }

  async function fetchModels() {
    if (pending || loadingModels || busy) return;
    const request = ++modelRequest.current;
    setLoadingModels(true);
    setNotice('');
    try {
      const result = await bridge.assistantModels(connectionDraft());
      if (live.current && request === modelRequest.current) {
        setModels(result.models);
        setModelListAddress(result.address);
        if (result.warning) setNotice(result.warning);
      }
    } catch (cause) {
      if (live.current && request === modelRequest.current) setNotice(agentPanelError(cause));
    } finally {
      if (live.current && request === modelRequest.current) setLoadingModels(false);
    }
  }

  async function saveSettings(forget = false) {
    if (!settings || !model.trim() || pending || busy) return;
    setPending(true);
    setNotice('');
    try {
      const next = await bridge.assistantConfigure({ ...connectionDraft(), model: model.trim(), remember, forget,
        reasoningEffort: editedEffort === selectedEffort ? selectedEffort : undefined });
      setSettings(next);
      loadDraft(next);
      if (next.conversationReset) clearConversation();
      else if (!paused && editedEffort) setTurnEffort(undefined);
      if (isConfigured(next.profiles[next.provider])) setConfiguredOpen(false);
    } catch (cause) { setNotice(agentPanelError(cause)); }
    finally { setPending(false); }
  }

  async function saveInstructions() {
    setSavingCustom(true);
    setNotice('');
    try {
      const next = await bridge.assistantSaveInstructions(custom);
      setSettings(next);
      setCustom(next.customInstructions);
      setNotice('已保存自定义指令，将在下一轮处理时生效。');
    } catch (cause) { setNotice(agentPanelError(cause)); }
    finally { setSavingCustom(false); }
  }

  function pump() {
    if (!live.current || active.current || interrupted.current || requestingGuidance.current) return;
    const next = queue.current.shift();
    if (next) void run(next);
  }

  async function run(draft: Draft, continuation = false) {
    const slot: Active = { draft, controller: new AbortController(), host: continuation, stopping: false };
    active.current = slot;
    interrupted.current = null;
    setActivity(undefined);
    const current = latestSettings.current;
    if (!continuation) {
      setTurnEffort({ type: 'reasoning-effort', turnId: draft.id, requested: current?.profiles[current.provider].reasoningEffort });
    }
    setBusy(true);
    setPaused(false);
    setStopping(false);
    setUser(draft, 'running');
    setNotice('');
    let receipt: AssistantTurnReceipt | undefined;
    let interruptionMessage = '';
    try {
      if (continuation) receipt = await bridge.assistantContinue();
      else {
        const request = await outbound(draft, slot.controller.signal);
        slot.controller.signal.throwIfAborted();
        slot.host = true;
        receipt = await bridge.assistantSend(request);
      }
    } catch (cause) {
      if (slot.stopping) receipt = { status: 'cancelled' };
      else {
        interruptionMessage = agentPanelError(cause);
        receipt = { status: 'incomplete' };
        if (slot.host) {
          try { slot.host = (await bridge.assistantSettings()).paused; } catch { /* Preserve the last known request state. */ }
        }
      }
    } finally {
      if (!live.current || active.current !== slot) return;
      active.current = null;
      setBusy(false);
      setStopping(false);
      if (receipt?.status === 'completed') {
        setActivity(undefined);
        setUser(draft, 'returned');
        pump();
      } else if (interruptionMessage && !slot.host) {
        setActivity(undefined);
        setUser(draft, 'unsent');
        addReply({ type: 'notice', id: draft.id + '/unsent', turnId: draft.id, text: interruptionMessage });
        pump();
      } else {
        interrupted.current = { draft, host: slot.host };
        setActivity({ type: 'activity', turnId: draft.id, phase: 'paused' });
        setPaused(true);
        setUser(draft, interruptionMessage ? 'error' : 'stopped');
        if (interruptionMessage) setNotice(interruptionMessage);
      }
    }
  }

  function enqueue(text: string, files: Attachment[], previous?: Draft) {
    const current = latestSettings.current;
    if (pending || (!text.trim() && !files.length) || sendProblem(current?.profiles[current.provider], files.length > 0)) return;
    const id = crypto.randomUUID();
    const draft: Draft = { id, text, files, replayOf: previous?.replayOf ?? previous?.id };
    queue.current.push(draft);
    followLatest.current = true;
    setEntries(rows => [...rows, { type: 'user', id, draft, status: 'queued' }]);
    pump();
  }

  async function guide(draft: Draft) {
    const target = active.current;
    if (!queue.current.includes(draft) || !target?.host || target.stopping || guides.current.has(draft.id)) return;
    requestingGuidance.current++;
    const guide = { draft, controller: new AbortController() };
    guides.current.set(draft.id, guide);
    setUser(draft, 'guiding');
    try {
      const problem = sendProblem(latestSettings.current?.profiles[latestSettings.current.provider], draft.files.length > 0);
      if (problem) throw new Error(problem);
      const request = { id: draft.id, replayOf: draft.replayOf, text: draft.text };
      if (await bridge.assistantGuide(request, draft.files.length > 0)) {
        queue.current = queue.current.filter(item => item !== draft);
        return;
      }
      setNotice('当前轮已结算，消息会按原顺序处理。');
    } catch (cause) { if (live.current && !guide.controller.signal.aborted) setNotice(agentPanelError(cause)); }
    finally {
      requestingGuidance.current--;
      if (live.current) queueMicrotask(pump);
    }
    if (guides.current.get(draft.id) === guide) {
      guide.controller.abort();
      guides.current.delete(draft.id);
      setUser(draft, 'queued');
    }
  }

  function stop() {
    const slot = active.current;
    if (!slot || slot.stopping) return;
    slot.stopping = true;
    setStopping(true);
    if (slot.host) {
      void bridge.assistantCancel().catch(cause => {
        if (active.current !== slot) return;
        slot.stopping = false;
        setStopping(false);
        setNotice(agentPanelError(cause));
      });
    } else slot.controller.abort();
  }

  async function reset() {
    try {
      await bridge.assistantReset();
      clearConversation(false);
      setNotice('');
    } catch (cause) { setNotice(agentPanelError(cause)); }
  }

  function addFiles(files: File[]) {
    const items = files.filter(file => file.size > 0 && (imageMime.test(file.type) || imageFormat.test(file.name))).map(makeAttachment);
    if (items.length !== files.length) setNotice('请选择有内容的 PNG、JPEG、BMP、TIFF、WebP 或 GIF 图片。');
    else if (items.length) setNotice('');
    if (items.length) setAttachments(previous => [...previous, ...items]);
  }

  function makeAttachment(file: File) {
    const url = URL.createObjectURL(file);
    previews.current.add(url);
    return { id: crypto.randomUUID(), file, url };
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }
  const attachmentProblem = attachments.length ? sendProblem(visibleSettings, true) : undefined;
  const canSend = Boolean(!pending && (message.trim() || attachments.length) && !sendProblem(visibleSettings, attachments.length > 0));
  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    enqueue(message, attachments);
    setMessage('');
    setAttachments([]);
  }

  function attachmentRows(files: Attachment[], removable = false) {
    if (!files.length) return null;
    return <ul className="es-agent-attachment-list">{files.map(row => {
      const facts = nativeImages.get(row.id);
      return <li key={row.id}>
        <img src={row.url} alt="" />
        <span>{row.file.name}{facts?.documentId && <small>已打开二维草稿</small>}{facts?.error && <small>{facts.error}</small>}</span>
        {onOpenImage && <button type="button" aria-label={'在二维编辑器打开 ' + row.file.name} disabled={Boolean(openingImage)}
          onClick={() => void openNativeImage(row)}>{openingImage === row.id ? '正在打开…' : '打开二维'}</button>}
        {removable && <button type="button" aria-label={'移除附件 ' + row.file.name} onClick={() => {
          if (openingImage === row.id) nativeOpening.current?.abort();
          URL.revokeObjectURL(row.url);
          previews.current.delete(row.url);
          setAttachments(previous => previous.filter(file => file.id !== row.id));
          setNativeImages(previous => { const next = new Map(previous); next.delete(row.id); return next; });
        }}><X size={13} aria-hidden="true" /></button>}
      </li>;
    })}</ul>;
  }

  return <div className="es-agent-assistant">
    <div className="es-agent-tools">
      {settings && <span>{providerNames[settings.provider]}{visibleSettings?.model && ' · ' + visibleSettings.model}</span>}
      {assistantReady && <small className="es-agent-effort" data-testid="es-agent-reasoning-effort">
        思考 · {effortLabel}{actualEffort && ' · 实际 ' + effortText(actualEffort)}
      </small>}
      <button type="button" disabled={!settings || pending} aria-expanded={configuredOpen} onClick={() => {
        if (settings && !configuredOpen) { loadDraft(settings); setCustom(settings.customInstructions); }
        if (configuredOpen) clearModelList();
        setConfiguredOpen(open => !open);
      }}>服务设置</button>
      <button type="button" disabled={busy || pending || !entries.length} onClick={() => void reset()}>新对话</button>
      {notice && <span className="es-agent-notice" role="status">{notice}<button type="button" aria-label="关闭助手提示" onClick={() => setNotice('')}>×</button></span>}
    </div>
    {configuredOpen && settings && <div className="es-agent-settings" data-first-run={!assistantReady}>
      <form className="es-agent-service-form" onSubmit={event => { event.preventDefault(); void saveSettings(); }}>
        <div className="es-agent-tools">
          <label className="es-agent-inline">服务<select aria-label="服务" value={provider} onChange={event => loadDraft(settings, event.target.value as AssistantProvider)} disabled={pending || busy}>
            {Object.entries(providerNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          <label className="es-agent-inline">API 密钥<input type="password" value={apiKey} onChange={event => {
            setApiKey(event.target.value);
            clearModelList();
          }} placeholder={editedSettings?.hasKey ? '已设置' : editedSettings?.keyRequired === false ? '可选' : undefined}
            autoComplete="off" spellCheck={false} disabled={pending || busy} /></label>
          <label className="es-agent-inline"><input type="checkbox" checked={remember} disabled={!settings.canRemember || pending || busy} onChange={event => setRemember(event.target.checked)} />记住密钥</label>
          {!settings.canRemember && <small className="es-agent-inline-warning" role="status">当前环境系统钥匙串加密不可用，密钥仅限本次会话使用。</small>}
        </div>
        <div className="es-agent-tools">
          <label className="es-agent-inline">模型<input value={model} onChange={event => setModel(event.target.value)} disabled={pending || busy} spellCheck={false} required /></label>
          <label className="es-agent-inline">思考强度<select value={selectedEffort} disabled={pending || busy || !effortLevels.length}
            onChange={event => setEffortDraft({ connection: effortConnection, value: event.target.value })}>
            <option value="default">服务默认{selectedModel?.reasoningDefault ? `（${effortText(selectedModel.reasoningDefault)}）` : ''}</option>
            {effortLevels.map(level => <option key={level} value={level}>{effortText(level)}</option>)}
          </select></label>
          <button type="button" aria-busy={loadingModels} disabled={pending || busy || loadingModels} onClick={() => void fetchModels()}>
            获取模型列表
          </button>
          {loadingModels && <small role="status">正在获取模型…</small>}
          {modelListAddress && <small>模型列表 {modelListAddress}</small>}
          {models && (models.length > 0 ? <label className="es-agent-inline">从列表选择<select aria-label="从列表选择" value={models.some(item => item.id === model) ? model : ''}
            disabled={pending || busy || loadingModels} onChange={event => setModel(event.target.value)}>
            <option value="" disabled>选择…</option>
            {models.map(item => <option key={item.id} value={item.id}>
              {item.name && item.name !== item.id ? `${item.name} (${item.id})` : item.id}
            </option>)}
          </select></label> : <small role="status">服务未返回模型，请手动填写。</small>)}
          <small className="es-agent-model-capabilities">图像能力 {capabilityText(selectedModel?.vision)} · 工具调用 {capabilityText(selectedModel?.tools)}</small>
        </div>
        <details key={provider} className="es-agent-service-advanced" open={provider === 'custom'}>
          <summary>高级设置</summary>
          <div className="es-agent-tools">
            <label className="es-agent-inline">Base URL<input inputMode="url" value={baseUrl} spellCheck={false}
              placeholder={editedSettings?.defaultBaseUrl || undefined}
              disabled={pending || busy} onChange={event => { setBaseUrl(event.target.value); clearModelList(); }} /></label>
            <label className="es-agent-inline">接口协议<select value={protocol} disabled={pending || busy} onChange={event => {
              setProtocol(event.target.value as AssistantProtocol);
              clearModelList();
            }}>
              {Object.entries(protocolNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select></label>
          </div>
          {editedSettings?.defaultBaseUrl && <small>留空使用服务的默认地址。</small>}
          {editedSettings?.address && <small>已保存的对话地址 {editedSettings.address}</small>}
        </details>
        {provider === 'kimi' && <small>Kimi 开放平台使用平台 API 密钥。Kimi Code 会员密钥请在「自定义」中按 Kimi Code 提供的服务地址和协议设置。图像和工具能力以实际接口为准。</small>}
        <div className="es-agent-tools">
          <button type="submit" disabled={pending || busy || !model.trim()}>应用</button>
          {(editedSettings?.hasKey || editedSettings?.remembered) && <button type="button" disabled={pending || busy} onClick={() => void saveSettings(true)}>移除密钥</button>}
        </div>
      </form>
      {editedSettings?.warning && <p className="es-agent-inline-warning" role="status">{editedSettings.warning}</p>}
      <details className="es-agent-custom-instructions">
        <summary>自定义指令</summary>
        <textarea aria-label="自定义指令" value={custom} onChange={event => setCustom(event.target.value)} rows={3} />
        <button type="button" disabled={savingCustom || custom === (settings.customInstructions ?? '')} onClick={() => void saveInstructions()}>保存自定义指令</button>
        {settings.instructionsWarning && <span role="status">{settings.instructionsWarning}</span>}
      </details>
    </div>}
    <div className="es-agent-log" role="log" aria-label="助手对话" aria-busy={busy} ref={log}
      onScroll={event => {
        const node = event.currentTarget;
        // A collapsed dock may reset the scroll position before it is shown again.
        if (!node.closest('[hidden]')) followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 32;
      }}>
      {entries.map((entry, index) => entry.type === 'user'
        ? <div className="es-agent-entry es-agent-entry-user" key={entry.id}>
          {entry.draft.text && <div>{entry.draft.text}</div>}
          {attachmentRows(entry.draft.files)}
          <div className="es-agent-message-actions">
            {entry.id === phaseTurnId && phase && phase !== 'idle' && (entry.status === 'running' || phase === 'paused')
              ? <small className="es-agent-activity" data-testid="es-agent-activity" role="status" data-phase={phase}>
                <i aria-hidden="true" />{entry.status === 'error' ? statusText.error : activityText[phase]}
              </small>
              : entry.status !== 'returned' && <small>{statusText[entry.status]}</small>}
            {entry.status === 'queued' && active.current?.host && !stopping && <button type="button" onClick={() => void guide(entry.draft)}>引导</button>}
            {entry.status === 'unsent' ? <button type="button" disabled={pending || Boolean(message || attachments.length)} onClick={() => {
              setMessage(entry.draft.text);
              setAttachments(entry.draft.files.map(({ file }) => makeAttachment(file)));
            }}>编辑重发</button> : entry.status !== 'queued' && entry.status !== 'running' && entry.status !== 'guiding' && <button type="button" disabled={pending || Boolean(sendProblem(visibleSettings, entry.draft.files.length > 0))} onClick={() => enqueue(entry.draft.text, entry.draft.files, entry.draft)}>重发</button>}
          </div>
        </div>
        : <ReplyRow key={entry.type + '/' + (entry.id ?? index)} entry={entry}
          turnActive={entry.type === 'reasoning' && busy && active.current?.draft.id === entry.turnId} />)}
    </div>
    <form className="es-agent-compose" data-agent-compose data-dragging={dragging} onSubmit={send}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop}>
      {attachmentRows(attachments, true)}
      {attachmentProblem && <small role="status">{attachmentProblem}</small>}
      <textarea aria-label="发给助手的消息" placeholder={assistantReady ? '发给助手的消息，可拖入或粘贴图片' : '配置服务后可发送消息和图片'} value={message} onChange={event => setMessage(event.target.value)} rows={2}
        onPaste={event => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          if (!event.clipboardData.getData('text/plain')) event.preventDefault();
          addFiles(files);
        }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
          event.preventDefault(); event.stopPropagation(); send();
        }} />
      <div className="es-agent-compose-actions">
        <div className="es-agent-message-actions">
          <input hidden type="file" multiple accept="image/png,image/jpeg,image/bmp,image/tiff,image/webp,image/gif,.bmp,.tif,.tiff" aria-label="添加图片附件" ref={fileInput} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <button type="button" aria-label="添加图片" onClick={() => fileInput.current?.click()}><Paperclip size={15} aria-hidden="true" /></button>
          <button type="submit" className="es-agent-primary" disabled={!canSend}><Send size={14} aria-hidden="true" />发送</button>
          {busy && <button type="button" disabled={stopping} onClick={stop}><Square size={13} aria-hidden="true" />{stopping ? '等待已发操作结算…' : '停止助手'}</button>}
          {paused && <button type="button" disabled={pending} onClick={() => {
            const latest = interrupted.current;
            if (latest && !active.current) void run(latest.draft, latest.host);
          }}>继续</button>}
        </div>
        {settings && <small>消息、图片和工具回执发送至 {providerNames[settings.provider]}。</small>}
      </div>
    </form>
  </div>;
}
