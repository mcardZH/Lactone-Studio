import { useEffect, useRef, useState } from 'react';

/** Own repeat timing instead of inheriting the OS keyboard delay/rate. The
 * callback is refreshed by the owner, so a held key cannot retain an old store. */
export function createHeldUndoRepeater() {
  let delay: ReturnType<typeof setTimeout> | undefined, repeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = undefined; repeat = undefined; };
  return {
    stop,
    get active() { return delay !== undefined || repeat !== undefined; },
    start(undo: () => void, canContinue: () => boolean) {
      if (delay !== undefined || repeat !== undefined) return;
      if (!canContinue()) return;
      undo();
      delay = setTimeout(() => {
        delay = undefined;
        if (!canContinue()) { stop(); return; }
        undo();
        repeat = setInterval(() => { if (canContinue()) undo(); else stop(); }, 100);
      }, 1000);
    },
  };
}

export interface ModelHoldKeyBindings { select: string; freeze: string }
interface HoldKeySnapshot { version: string; bindings: ModelHoldKeyBindings; writable: boolean; error?: string }
interface HoldKeyAPI {
  readModelHoldKeyPreferences(): Promise<HoldKeySnapshot>;
  writeModelHoldKeyPreferences(value: { baseVersion: string; bindings: ModelHoldKeyBindings }): Promise<HoldKeySnapshot>;
}
export const DEFAULT_HOLD_KEYS: ModelHoldKeyBindings = { select: 'r', freeze: 'f' };
export function validateHoldKeys(bindings: ModelHoldKeyBindings): ModelHoldKeyBindings {
  const result = { select: bindings.select.trim().toLowerCase(), freeze: bindings.freeze.trim().toLowerCase() };
  if (!/^[a-z]$/.test(result.select) || !/^[a-z]$/.test(result.freeze)) throw new Error('快捷键须为单个英文字母。');
  if (result.select === result.freeze) throw new Error('选择和冻结快捷键不能相同。');
  return result;
}
export function useModelShortcuts() {
  const api = window.sciyueDesktop as unknown as Partial<HoldKeyAPI> | undefined;
  const [snapshot, setSnapshot] = useState<HoldKeySnapshot>({ version: 'browser-session', bindings: DEFAULT_HOLD_KEYS, writable: !api });
  const [errorNotice,setErrorNotice]=useState({text:'',revision:0}), pending = useRef(false), alive = useRef(true), receiptEpoch = useRef(0);
  const setError=(text:string)=>setErrorNotice(previous=>({text,revision:previous.revision+1}));
  const latest = useRef(snapshot); latest.current = snapshot;
  useEffect(() => {
    alive.current = true;
    const epoch=receiptEpoch.current;
    const receive=(event:Event)=>{try{const next=(event as CustomEvent<HoldKeySnapshot>).detail;if(!next||typeof next.version!=='string'||typeof next.writable!=='boolean')return;const bindings=validateHoldKeys(next.bindings);receiptEpoch.current++;setSnapshot({...next,bindings});setError(next.error??'');}catch{/* Ignore malformed local notifications; saved profile remains authoritative. */}};
    window.addEventListener('sciyue-model-hold-keys-changed',receive);
    if (api?.readModelHoldKeyPreferences) void api.readModelHoldKeyPreferences().then(next => { if (alive.current&&receiptEpoch.current===epoch) { setSnapshot({ ...next, bindings: validateHoldKeys(next.bindings) }); setError(next.error ?? ''); } }).catch(cause => { if (alive.current&&receiptEpoch.current===epoch) { setSnapshot(previous => ({ ...previous, writable: false })); setError(String(cause)); } });
    return () => { alive.current = false; window.removeEventListener('sciyue-model-hold-keys-changed',receive); };
  }, []);
  async function save(kind: keyof ModelHoldKeyBindings, value: string):Promise<ModelHoldKeyBindings|null> {
    if (pending.current) return null;
    try {
      const previous = latest.current, bindings = validateHoldKeys({ ...previous.bindings, [kind]: value });
      if (!previous.writable) throw new Error('当前快捷键偏好只读，原文件保留。');
      pending.current = true;
      const next = api?.writeModelHoldKeyPreferences ? await api.writeModelHoldKeyPreferences({ baseVersion: previous.version, bindings }) : { ...previous, bindings };
      if (alive.current) { const accepted={...next,bindings:validateHoldKeys(next.bindings)};setSnapshot(accepted);setError(next.error??'');window.dispatchEvent(new CustomEvent('sciyue-model-hold-keys-changed',{detail:accepted})); }
      return validateHoldKeys(next.bindings);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); return null; }
    finally { pending.current = false; }
  }
  return { bindings: snapshot.bindings, writable: snapshot.writable, error:errorNotice.text, errorRevision:errorNotice.revision, save };
}
/** Editable corner is a separate input, never a nested button or a model shortcut target. */
export function HoldKeyCorner({ kind, value, writable, save }: { kind: keyof ModelHoldKeyBindings; value: string; writable: boolean; save(kind: keyof ModelHoldKeyBindings, value: string): Promise<ModelHoldKeyBindings|null> }) {
  const [text, setText] = useState(value.toUpperCase());
  useEffect(() => { setText(value.toUpperCase()); }, [value]);
  const commit = () => { if (text.toLowerCase() !== value) void save(kind, text).then(accepted=>setText((accepted?.[kind]??value).toUpperCase())); };
  return <input aria-label={kind === 'select' ? '选择框选快捷键' : '冻结框选快捷键'} title="按住使用；单个英文字母" value={text} disabled={!writable} maxLength={1}
    style={{ position: 'absolute', right: 2, bottom: 1, width: 18, minWidth: 18, height: 17, padding: 0, margin: 0, fontSize: 10, lineHeight: '15px', textAlign: 'center', border: 0, borderRadius: 2, background: '#ffffffba', color: '#3b6373' }}
    onPointerDown={event => event.stopPropagation()} onChange={event => setText(event.target.value)} onBlur={commit}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } }} onKeyUp={event => event.stopPropagation()} />;
}
