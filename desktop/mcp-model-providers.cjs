'use strict';

// Provider transport only: no settings files, credentials lookup, tools dispatch,
// retry, conversation management or windows. fetch and delta consumers are injected.
const presets = {
  openai: { title: 'OpenAI', model: 'gpt-6.2-sol', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' },
  deepseek: { title: 'DeepSeek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', protocol: 'chat' },
  claude: { title: 'Claude', model: '', baseUrl: 'https://api.anthropic.com/v1', protocol: 'messages' },
  gemini: { title: 'Gemini', model: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'chat' },
  ollama: { title: 'Ollama', model: '', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'chat', keyOptional: true },
  kimi: { title: 'Kimi 开放平台', model: '', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'chat' },
  glm: { title: 'GLM', model: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat' },
  custom: { title: '自定义', model: '', baseUrl: '', protocol: 'chat' },
};
const routes = { chat: 'chat/completions', responses: 'responses', messages: 'messages' };
const providers = Object.freeze(Object.fromEntries(Object.entries(presets).map(([id, value]) => [id, Object.freeze({
  ...value, endpoint: value.baseUrl ? `${value.baseUrl}/${routes[value.protocol]}` : '',
})])));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const rawToolArguments = Symbol('received-tool-arguments');

function absoluteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('模型服务 URL 必须是完整的 http 或 https 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('模型服务 URL 必须使用 http 或 https，账号密钥请填在独立字段。');
  url.hash = '';
  return url;
}

function normalizeProfile(provider, profile = {}) {
  const preset = providers[provider];
  if (!preset) throw Error('请选择支持的模型服务预设。');
  const protocol = profile.protocol ?? preset.protocol;
  if (!Object.hasOwn(routes, protocol)) throw Error('模型服务协议无效。');
  const base = profile.baseUrl?.trim() || preset.baseUrl;
  let endpoint, baseUrl;
  if (typeof profile.endpoint === 'string' && profile.endpoint.trim() && !profile.baseUrl) {
    endpoint = absoluteUrl(profile.endpoint.trim());
    baseUrl = new URL(endpoint);
    baseUrl.pathname = baseUrl.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '');
  } else {
    baseUrl = absoluteUrl(base);
    endpoint = new URL(baseUrl);
    // Also accept a customer-pasted full operation URL as the base field.
    endpoint.pathname = endpoint.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '').replace(/\/$/, '') + '/' + routes[protocol];
    baseUrl.pathname = endpoint.pathname.slice(0, -routes[protocol].length).replace(/\/$/, '');
  }
  const key = profile.key ?? profile.apiKey ?? '';
  if (typeof key !== 'string' || /[\s\u0000-\u001f\u007f]/u.test(key)) throw Error('API 密钥含无效字符。');
  const modelCapabilities = object(profile.modelCapabilities) ? { ...profile.modelCapabilities } : {};
  const maxOutputTokens = profile.maxOutputTokens ?? modelCapabilities.maxOutputTokens;
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1))
    throw Error('最大输出 token 数必须是正整数。');
  return { ...profile, provider, title: preset.title, protocol, baseUrl: baseUrl.href.replace(/\/$/, ''), endpoint: endpoint.href,
    model: typeof profile.model === 'string' ? profile.model.trim() : preset.model, key, modelCapabilities,
    maxOutputTokens, stream: profile.stream !== false, keyOptional: preset.keyOptional === true || profile.keyOptional === true };
}

function headers(profile) {
  return { 'Content-Type': 'application/json', ...(profile.protocol === 'messages'
    ? { 'anthropic-version': '2023-06-01', ...(profile.key ? { 'x-api-key': profile.key } : {}) }
    : profile.key ? { Authorization: `Bearer ${profile.key}` } : {}) };
}
function safeCode(value, key) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,60}$/i.test(value) && !(key && value.includes(key)) ? `（${value}）` : '';
}
function serviceAddress(value, key) {
  const url = new URL(value);
  if (!key) return url.origin + url.pathname;
  const marker = '[已隐藏凭据]';
  const origin = url.origin.replaceAll(key, marker);
  const route = url.pathname.replaceAll(key, marker);
  try {
    // Keep the exact printable route unless its encoded form contains the key.
    if (!decodeURIComponent(route).includes(key)) return origin + route;
  } catch { /* A malformed escape cannot be checked safely for credentials. */ }
  return origin + '/' + marker;
}
function operationLabel(profile, operation, url) {
  return `${profile.title} · ${operation}（${serviceAddress(url, profile.key)}）`;
}
async function checkHttp(response, profile, label) {
  if (response.ok) return;
  const body = await response.json().catch(() => undefined);
  const hints = {
    400: '请核对模型名称和接口协议。',
    401: '请核对密钥是否属于这个服务地址。',
    403: '请核对密钥的权限和模型使用资格。',
    404: '请核对服务地址、接口协议和模型名称。',
    429: '请检查服务配额或稍后重试。',
  };
  throw Error(`${label}返回 HTTP ${response.status}${safeCode(body?.error?.code ?? body?.error?.type, profile.key)}。${hints[response.status] ?? '请检查服务状态后重试。'}`);
}
async function fetchSafe(url, options, profile, label, fetchImpl) {
  options.signal?.throwIfAborted();
  try { return await fetchImpl(url, { ...options, redirect: 'error' }); }
  catch (error) {
    options.signal?.throwIfAborted();
    // Native fetch exceptions and response messages can echo headers/URLs. Keep
    // only the operation's public category; no raw cause or credential is logged.
    throw Error(`${label}连接失败${safeCode(error?.code, profile.key)}。请检查网络和服务地址。`);
  }
}

/** Incremental SSE framing. A chunk is not a line, UTF-8 character or JSON event.
 * An unterminated final event is deliberately not promoted to a completed event. */
async function* readSse(body, signal) {
  if (!body?.getReader) throw Error('模型服务没有返回可读取的数据流。');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = 'message', data = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  function line(value) {
    if (!value) {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      event = 'message'; data = []; return result;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon);
    let text = colon < 0 ? '' : value.slice(colon + 1);
    if (text.startsWith(' ')) text = text.slice(1);
    if (field === 'data') data.push(text);
    else if (field === 'event') event = text;
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let start = 0;
      for (let index = 0; index < buffer.length; index++) {
        const code = buffer.charCodeAt(index);
        if (code !== 10 && code !== 13) continue;
        if (code === 13 && index === buffer.length - 1 && !chunk.done) break;
        const value = buffer.slice(start, index);
        if (code === 13 && buffer.charCodeAt(index + 1) === 10) index++;
        start = index + 1;
        const frame = line(value); if (frame) yield frame;
      }
      buffer = buffer.slice(start);
      if (chunk.done) break;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

function toolContent(value) {
  if (typeof value === 'string') return { text: value };
  if (!object(value) || typeof value.text !== 'string') throw Error('工具回执缺少文本内容。');
  return value;
}
function imageUrl(image) {
  if (!image || typeof image.mimeType !== 'string' || typeof image.data !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(image.mimeType))
    throw Error('图像格式无效。');
  return `data:${image.mimeType};base64,${image.data}`;
}
function messageParts(protocol, text, images) {
  if (protocol === 'responses') return [
    { type: 'input_text', text },
    ...images.map(image => ({ type: 'input_image', image_url: imageUrl(image), detail: 'auto' })),
  ];
  return [
    { type: 'text', text },
    ...images.map(image => protocol === 'messages'
      ? { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }
      : { type: 'image_url', image_url: { url: imageUrl(image), detail: 'auto' } }),
  ];
}

function userMessage(profile, text, images) {
  return { role: 'user', content: images.length ? messageParts(profile.protocol, text, images) : text };
}
function resultMessage(profile, id, value) {
  let { text, image } = toolContent(value);
  if (image && profile.modelCapabilities.toolResultImages === false) {
    text += '\n该模型配置未启用工具图像，本次仅发送文本回执。'; image = undefined;
  }
  const content = image ? messageParts(profile.protocol, text, [image]) : text;
  if (profile.protocol === 'responses') return { type: 'function_call_output', call_id: id, output: content };
  if (profile.protocol === 'messages') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
  return { role: 'tool', tool_call_id: id, content };
}

function validCallIdentities(calls) {
  const ids = new Set();
  return calls.every(call => {
    if (typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof call.name !== 'string' || !call.name || typeof call.args !== 'string') return false;
    ids.add(call.id);
    return true;
  });
}
function markInputError(call) {
  try {
    if (!object(JSON.parse(call.args))) throw Error('工具参数顶层必须是 JSON 对象。');
    return call;
  } catch (error) {
    // This is a protocol-complete invocation for host-side correction only.
    // Keep the original bytes for the error receipt; never replace dispatch args.
    return { ...call, inputError: { code: 'invalid_tool_json', message: '工具参数不是完整有效的 JSON 对象，本次调用未执行。',
      syntaxError: error.message, rawArguments: call.args } };
  }
}
function correctionHistory(history, calls) {
  const malformed = new Set(calls.filter(call => call.inputError).map(call => call.id));
  if (!malformed.size) return history;
  return history.map(item => {
    if (item.type === 'function_call' && malformed.has(item.call_id)) return { ...item, arguments: '{}' };
    if (item.role !== 'assistant') return item;
    return { ...item,
      ...(Array.isArray(item.tool_calls) ? { tool_calls: item.tool_calls.map(call => malformed.has(call.id)
        ? { ...call, function: { ...call.function, arguments: '{}' } } : call) } : {}),
      ...(Array.isArray(item.content) ? { content: item.content.map(part => part.type === 'tool_use' && malformed.has(part.id)
        ? { ...part, input: {} } : part) } : {}),
    };
  });
}
function reportedEffort(response) {
  const effort = response?.reasoning?.effort ?? response?.reasoning_effort ?? response?.output_config?.effort;
  return ['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort) ? effort : undefined;
}
function finalize(profile, { texts = [], reasoning = [], calls = [], history = [], complete, status, usage, actualEffort, warning, streamed = false, streamedText = false }) {
  if (calls.length && !validCallIdentities(calls)) { complete = false; warning = `${profile.title} 工具调用身份或参数字段不完整，未派发工具。`; }
  if (complete) {
    calls = calls.map(markInputError);
    // Only replay the malformed input as canonical JSON so the matching error
    // tool-result remains protocol-valid. The host must branch on inputError and
    // must never dispatch this history-only placeholder.
    history = correctionHistory(history, calls);
  }
  if (!complete) history = history.filter(item => item.type !== 'function_call').map(item => {
    if (item.role !== 'assistant') return item;
    const { tool_calls: _calls, ...rest } = item;
    return { ...rest, ...(Array.isArray(item.content) ? { content: item.content.filter(part => part.type !== 'tool_use') } : {}) };
  });
  return { texts, reasoning, calls: complete ? calls : [], history, complete: complete === true, status, usage, actualEffort,
    warning: warning ?? (complete ? undefined : `${profile.title} 响应尚未完整结束（${status ?? 'unknown'}），未派发工具。`),
    streamed, streamedText, toolResult: (id, value) => resultMessage(profile, id, value) };
}

function chatResult(profile, response, transportComplete = true, extra = {}) {
  const choice = response.choices?.find(row => row.index === 0) ?? response.choices?.[0], message = choice?.message;
  if (!object(message)) throw Error(`${profile.title} 返回的助手消息不完整。`);
  const finish = choice.finish_reason;
  const calls = finish === 'tool_calls' && Array.isArray(message.tool_calls) ? message.tool_calls.map(call => ({ id: call.id, name: call.function?.name, args: call.function?.arguments })) : [];
  const complete = transportComplete && ['stop', 'tool_calls'].includes(finish) &&
    (finish === 'tool_calls' ? calls.length > 0 : !message.tool_calls?.length);
  const history = [{ role: 'assistant', content: message.content ?? null,
    ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
    ...(complete && calls.length ? { tool_calls: copy(message.tool_calls) } : {}) }];
  return finalize(profile, { texts: typeof message.content === 'string' && message.content ? [message.content] : [],
    reasoning: typeof message.reasoning_content === 'string' && message.reasoning_content ? [{ kind: 'reasoning', text: message.reasoning_content }] : [],
    calls, history, complete, status: finish, usage: response.usage, actualEffort: reportedEffort(response), ...extra });
}
function responsesResult(profile, response, transportComplete = true, extra = {}) {
  if (!Array.isArray(response.output)) throw Error(`${profile.title} 返回的助手消息不完整。`);
  const complete = transportComplete && response.status === 'completed' &&
    response.output.every(item => item.type !== 'function_call' || item.status === undefined || item.status === 'completed');
  return finalize(profile, { texts: response.output.flatMap(item => item.type === 'message' && Array.isArray(item.content)
    ? item.content.map(content => content.type === 'output_text' ? content.text : content.refusal).filter(text => typeof text === 'string') : []),
    reasoning: response.output.flatMap(item => item.type === 'reasoning' && Array.isArray(item.summary)
      ? item.summary.filter(part => part.type === 'summary_text' && typeof part.text === 'string').map(part => ({ kind: 'summary', text: part.text })) : []),
    calls: response.output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, args: item.arguments })),
    history: copy(response.output), complete, status: response.status, usage: response.usage, actualEffort: reportedEffort(response), ...extra });
}
function messagesResult(profile, response, transportComplete = true, extra = {}) {
  if (!Array.isArray(response.content)) throw Error(`${profile.title} 返回的助手消息不完整。`);
  const finish = response.stop_reason, hasTools = response.content.some(part => part.type === 'tool_use');
  const complete = transportComplete && ['end_turn', 'stop_sequence', 'tool_use'].includes(finish) && (finish === 'tool_use' ? hasTools : !hasTools);
  return finalize(profile, { texts: response.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text),
    reasoning: response.content.filter(part => part.type === 'thinking' && typeof part.thinking === 'string').map(part => ({ kind: 'reasoning', text: part.thinking })),
    calls: finish === 'tool_use' ? response.content.filter(part => part.type === 'tool_use').map(part => ({ id: part.id, name: part.name,
      args: part[rawToolArguments] ?? JSON.stringify(part.input) })) : [],
    history: [{ role: 'assistant', content: copy(response.content.filter(part => complete || part.type !== 'tool_use')) }],
    complete, status: finish, usage: response.usage, actualEffort: reportedEffort(response), ...extra });
}

function streamAccumulator(profile, onDelta) {
  let textDeltas = false, terminal = false, warning, usage, actualEffort;
  let chat = { role: 'assistant', content: '' }, finish;
  const calls = new Map(), output = new Map(), blocks = new Map(), inputJson = new Map(), closedBlocks = new Set();
  let finalResponse, message = { role: 'assistant', content: [] };
  const emit = (type, text, reasoningKind) => {
    if (!text) return;
    if (type === 'text-delta') textDeltas = true;
    onDelta?.({ type, text, ...(reasoningKind ? { reasoningKind } : {}) });
  };
  function itemFor(event, type) {
    const key = event.output_index ?? [...output].find(([, item]) => item.id === event.item_id)?.[0];
    if (key === undefined) throw Error('无法归属流式输出片段。');
    if (!output.has(key)) output.set(key, { id: event.item_id, type, ...(type === 'message' ? { role: 'assistant', content: [] } : {}) });
    return output.get(key);
  }
  return {
    get terminal() { return terminal; },
    accept(frame) {
      if (terminal) return;
      if (frame.data === '[DONE]') { if (profile.protocol === 'chat') terminal = true; return; }
      const event = JSON.parse(frame.data), type = event.type ?? frame.event;
      actualEffort = reportedEffort(event.response ?? event.message ?? event) ?? actualEffort;
      if (event.error || type === 'error') { warning = `${profile.title} 数据流返回错误${safeCode(event.error?.code ?? event.error?.type ?? event.code, profile.key)}。`; terminal = true; return; }
      if (profile.protocol === 'chat') {
        usage = event.usage ?? usage;
        const choice = event.choices?.find(row => row.index === 0) ?? event.choices?.[0]; if (!choice) return;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string') { chat.content += delta.content; emit('text-delta', delta.content); }
        if (typeof delta.reasoning_content === 'string') { chat.reasoning_content = (chat.reasoning_content ?? '') + delta.reasoning_content; emit('reasoning-delta', delta.reasoning_content, 'reasoning'); }
        for (const fragment of delta.tool_calls ?? []) {
          if (!Number.isSafeInteger(fragment.index) || fragment.index < 0) throw Error('流式工具片段没有顺序身份。');
          const call = calls.get(fragment.index) ?? { type: 'function', function: { name: '', arguments: '' } };
          if (fragment.id) call.id = fragment.id;
          if (typeof fragment.function?.name === 'string') call.function.name += fragment.function.name;
          if (typeof fragment.function?.arguments === 'string') call.function.arguments += fragment.function.arguments;
          calls.set(fragment.index, call);
        }
        if (choice.finish_reason != null) finish = choice.finish_reason;
      } else if (profile.protocol === 'responses') {
        if (type === 'response.output_item.added' || type === 'response.output_item.done') output.set(event.output_index, copy(event.item));
        else if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
          const item = itemFor(event, 'message'), index = event.content_index ?? 0;
          item.content ??= []; item.content[index] ??= { type: 'output_text', text: '' };
          if (type.endsWith('.delta')) { item.content[index].text += event.delta; emit('text-delta', event.delta); }
          else item.content[index].text = event.text;
        } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_summary_text.done') {
          const item = itemFor(event, 'reasoning'), index = event.summary_index ?? 0;
          item.summary ??= []; item.summary[index] ??= { type: 'summary_text', text: '' };
          if (type.endsWith('.delta')) { item.summary[index].text += event.delta; emit('reasoning-delta', event.delta, 'summary'); }
          else item.summary[index].text = event.text;
        } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
          const item = itemFor(event, 'function_call');
          if (type.endsWith('.delta')) item.arguments = (item.arguments ?? '') + event.delta;
          else item.arguments = event.arguments;
        } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
          finalResponse = event.response; terminal = true;
          if (type !== 'response.completed') warning = `${profile.title} 响应状态为 ${type.slice(9)}。`;
        }
      } else {
        if (type === 'message_start') { message = copy(event.message); usage = message.usage; }
        else if (type === 'content_block_start') blocks.set(event.index, copy(event.content_block));
        else if (type === 'content_block_delta') {
          const block = blocks.get(event.index); if (!block) throw Error('流式内容片段没有所属块。');
          const delta = event.delta;
          if (delta.type === 'text_delta') { block.text = (block.text ?? '') + delta.text; emit('text-delta', delta.text); }
          else if (delta.type === 'thinking_delta') { block.thinking = (block.thinking ?? '') + delta.thinking; emit('reasoning-delta', delta.thinking, 'reasoning'); }
          else if (delta.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
          else if (delta.type === 'input_json_delta') inputJson.set(event.index, (inputJson.get(event.index) ?? '') + delta.partial_json);
        } else if (type === 'content_block_stop') {
          const block = blocks.get(event.index); if (!block) throw Error('流式内容块不存在。');
          if (inputJson.has(event.index)) {
            block[rawToolArguments] = inputJson.get(event.index);
            try { block.input = JSON.parse(block[rawToolArguments]); }
            catch { block.input = {}; }
          }
          closedBlocks.add(event.index);
        } else if (type === 'message_delta') { finish = event.delta?.stop_reason ?? finish; usage = { ...usage, ...event.usage }; }
        else if (type === 'message_stop') { terminal = true; if ([...blocks.keys()].some(index => !closedBlocks.has(index))) warning = `${profile.title} 内容块尚未完整结束。`; }
      }
    },
    finish(extraWarning) {
      const extra = { streamed: true, streamedText: textDeltas, warning: extraWarning ?? warning, ...(actualEffort ? { actualEffort } : {}) };
      if (profile.protocol === 'chat') return chatResult(profile, { choices: [{ message: { ...chat, tool_calls: [...calls].sort((a, b) => a[0] - b[0]).map(([, value]) => value) }, finish_reason: finish }], usage }, terminal && !warning && !extraWarning, extra);
      if (profile.protocol === 'responses') return responsesResult(profile, finalResponse ?? { status: 'incomplete', output: [...output].sort((a, b) => a[0] - b[0]).map(([, value]) => value), usage }, terminal && !warning && !extraWarning, extra);
      return messagesResult(profile, { ...message, content: [...blocks].sort((a, b) => a[0] - b[0]).map(([, value]) => value), stop_reason: finish, usage }, terminal && !warning && !extraWarning, extra);
    },
  };
}

function requestBody(profile, history, tools, instructions) {
  const functions = profile.modelCapabilities.tools === false ? [] : tools;
  const shared = { model: profile.model, stream: profile.stream };
  const effort = profile.reasoningEffort;
  const think = profile.provider === 'deepseek' && effort === 'none' ? 'disabled' : 'enabled';
  if (profile.protocol === 'responses') return { ...shared, instructions, input: history, store: false, include: ['reasoning.encrypted_content'],
    ...(profile.modelCapabilities.reasoningSummary === true || effort ? { reasoning: { ...(profile.modelCapabilities.reasoningSummary === true ? { summary: 'auto' } : {}), ...(effort ? { effort } : {}) } } : {}),
    ...(functions.length ? { tools: functions.map(tool => ({ type: 'function', ...tool, strict: false })) } : {}),
    ...(profile.maxOutputTokens ? { max_output_tokens: profile.maxOutputTokens } : {}) };
  if (profile.protocol === 'messages') return { ...shared, system: instructions, messages: history,
    max_tokens: profile.maxOutputTokens ?? 4096,
    ...(effort && profile.provider === 'deepseek' ? { thinking: { type: think }, ...(effort === 'none' ? {} : { output_config: { effort } }) } : {}),
    ...(functions.length ? { tools: functions.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}) };
  return { ...shared, messages: [{ role: 'system', content: instructions }, ...history],
    ...(effort ? { reasoning_effort: effort, ...(profile.provider === 'deepseek' ? { thinking: { type: think } } : {}) } : {}),
    ...(functions.length ? { tools: functions.map(tool => ({ type: 'function', function: tool })) } : {}),
    ...(profile.maxOutputTokens ? { max_tokens: profile.maxOutputTokens } : {}),
    ...(profile.stream && (profile.provider === 'deepseek' || profile.modelCapabilities.streamUsage === true) ? { stream_options: { include_usage: true } } : {}) };
}

async function requestModel(provider, settings, history, tools, signal, fetchImpl = fetch, instructions = '', onDelta, stage = '请求模型回复') {
  const profile = normalizeProfile(provider, settings);
  const label = operationLabel(profile, stage, profile.endpoint);
  if (!profile.model) throw Error('请填写模型名称。');
  if (!profile.key && !profile.keyOptional) throw Error(`${label}需要此服务的 API 密钥。`);
  const response = await fetchSafe(profile.endpoint, { method: 'POST', signal, headers: headers(profile),
    body: JSON.stringify(requestBody(profile, history, tools, instructions)) }, profile, label, fetchImpl);
  await checkHttp(response, profile, label); signal?.throwIfAborted();
  if (/text\/event-stream/i.test(response.headers?.get?.('content-type') ?? '')) {
    const accumulator = streamAccumulator(profile, onDelta);
    try {
      for await (const frame of readSse(response.body, signal)) { accumulator.accept(frame); if (accumulator.terminal) break; }
    } catch (error) {
      const partial = accumulator.finish('数据流中断或格式不完整，未派发工具。');
      if (signal?.aborted) { const aborted = Error('助手请求已取消。'); aborted.name = 'AbortError'; aborted.partial = partial; throw aborted; }
      return { ...partial, warning: `${label}：${partial.warning}请检查服务状态后重试。` };
    }
    const result = accumulator.finish();
    return result.warning ? { ...result, warning: `${label}：${result.warning}` } : result;
  }
  // The existing QA/native JSON fixtures and servers that ignore stream=true
  // keep their original response.json path. There is no automatic second POST.
  let payload;
  try { payload = await response.json(); } catch { signal?.throwIfAborted(); throw Error(`${label}的 JSON 响应无法读取。请核对接口协议。`); }
  signal?.throwIfAborted();
  let result;
  try {
    result = profile.protocol === 'responses' ? responsesResult(profile, payload) : profile.protocol === 'messages'
      ? messagesResult(profile, payload) : chatResult(profile, payload);
  } catch { throw Error(`${label}的响应格式不完整。请核对接口协议和模型名称。`); }
  for (const reasoning of result.reasoning) onDelta?.({ type: 'reasoning-delta', text: reasoning.text, reasoningKind: reasoning.kind });
  return result.warning ? { ...result, warning: `${label}：${result.warning}` } : result;
}

function publicCapabilityMetadata(value, key) {
  if (typeof value === 'string') return key ? value.replaceAll(key, '[已隐藏凭据]') : value;
  if (Array.isArray(value)) return value.map(item => publicCapabilityMetadata(item, key));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    key ? name.replaceAll(key, '[已隐藏凭据]') : name, publicCapabilityMetadata(item, key),
  ]));
  return value;
}
function listedModelCapabilities(capabilities) {
  if (!object(capabilities)) return;
  const result = {};
  // Interpret only explicit same-name upstream facts. Neither a model name nor
  // the lack of a field demonstrates support or lack of support.
  for (const name of ['vision', 'tools']) {
    const value = capabilities[name];
    if (typeof value === 'boolean') result[name] = value;
    else if (object(value) && typeof value.supported === 'boolean') result[name] = value.supported;
  }
  return Object.keys(result).length ? result : undefined;
}

async function listProviderModels(provider, settings, signal, fetchImpl = fetch) {
  const profile = normalizeProfile(provider, settings);
  const endpoint = new URL(profile.endpoint);
  endpoint.pathname = endpoint.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '/models');
  const address = serviceAddress(endpoint, profile.key);
  const label = operationLabel(profile, '获取模型列表', endpoint);
  if (!profile.key && !profile.keyOptional) throw Error(`${label}需要此服务的 API 密钥。`);
  const models = new Map(), cursors = new Set();
  while (true) {
    const response = await fetchSafe(endpoint.href, { method: 'GET', signal, headers: headers(profile) }, profile, label, fetchImpl);
    await checkHttp(response, profile, label); signal?.throwIfAborted();
    let payload; try { payload = await response.json(); } catch { signal?.throwIfAborted(); throw Error(`${label}的 JSON 响应无法读取。模型名称可手动填写。`); }
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.data)) throw Error(`${label}的响应格式不完整。模型名称可手动填写。`);
    for (const model of payload.data) {
      if (typeof model.id !== 'string' || !model.id || profile.key && model.id.includes(profile.key)) continue;
      const name = typeof model.display_name === 'string' && !(profile.key && model.display_name.includes(profile.key)) ? model.display_name : model.id;
      const actual = Object.hasOwn(model, 'capabilities') ? publicCapabilityMetadata(model.capabilities, profile.key) : undefined;
      const advertised = listedModelCapabilities(actual);
      const reasoningLevels = Array.isArray(model.effort?.supported_levels)
        ? [...new Set(model.effort.supported_levels.filter(level => ['minimal','low','medium','high','xhigh','max','ultra'].includes(level)))] : [];
      const reasoningDefault = reasoningLevels.includes(model.effort?.default_level) ? model.effort.default_level : undefined;
      const modelCapabilities = reasoningLevels.length ? { ...advertised, reasoningLevels, reasoningDefault } : advertised;
      models.set(model.id, { ...models.get(model.id), id: model.id, name,
        ...(actual !== undefined ? { capabilities: actual } : {}), ...(modelCapabilities ? { modelCapabilities } : {}) });
    }
    if (profile.protocol !== 'messages' || payload.has_more !== true) return { provider, protocol: profile.protocol, address, models: [...models.values()], complete: true };
    const cursor = payload.last_id;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) return { provider, protocol: profile.protocol, address, models: [...models.values()], complete: false, warning: '模型列表分页游标未前进，已保留读取到的模型。' };
    cursors.add(cursor); endpoint.searchParams.set('after_id', cursor);
  }
}

module.exports = { providers, normalizeProfile, serviceAddress, requestModel, listProviderModels, readSse, userMessage };
