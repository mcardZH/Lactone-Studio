import {DismissibleNotice} from './DismissibleNotice';
import { useEffect, useId, useRef, useState } from 'react';
import { FileInput } from 'lucide-react';
import type { ReferenceExtension, ReferenceFileSelection } from './reference-file';
import { absoluteReferencePath, selectedReference } from './reference-file';
import './source-options.css';

export interface ReferenceFileFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  extensions: ReferenceExtension[];
  placeholder?: string;
  disabled?: boolean;
  validationMessage?: string;
  /** Changes invalidate a pending native chooser without touching source files. */
  contextKey?: string;
  pickFile?: (request: { title: string; extensions: ReferenceExtension[] }) => Promise<ReferenceFileSelection | null>;
  getFilePath?: (file: File) => string;
  /** Compact filename/drop row, explicitly selected by the CHK consumer only. */
  compact?: boolean;
}

export default function ReferenceFileField({ label, value, onChange, extensions, placeholder, disabled = false, validationMessage, contextKey, pickFile, getFilePath, compact = false }: ReferenceFileFieldProps) {
  const chkCompact = compact && extensions.length===1 && extensions[0]==='chk';
  const input = useRef<HTMLInputElement>(null), version = useRef(0), mounted = useRef(true);
  const [selected, setSelected] = useState<ReferenceFileSelection | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false);
  const id = useId(), noteId = `${id}-note`;
  useEffect(() => { version.current++; setBusy(false); }, [value, disabled, contextKey]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  const nativePick = pickFile ?? (typeof window === 'undefined' ? undefined : window.sciyueDesktop?.pickReferenceFile);
  const filePath = getFilePath ?? (typeof window === 'undefined' ? undefined : window.sciyueDesktop?.getReferenceFilePath);
  function accept(selection: ReferenceFileSelection) {
    const next = selectedReference(selection, extensions);
    version.current++; setBusy(false); setSelected(next); setError(''); onChange(next.name);
  }
  function change(value: string) {
    version.current++; setBusy(false); setError(''); onChange(value);
  }
  function acceptFiles(files: File[]) {
    if (disabled) return;
    try {
      if (files.length !== 1) throw new Error('一次选择一个来源文件。');
      const file = files[0];
      let path: string | undefined;
      try { path = filePath?.(file) || undefined; } catch { /* Browser File may have no native path. */ }
      accept({ name: file.name, path });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '来源文件选择失败。'); }
  }
  async function choose() {
    if (disabled || busy) return;
    if (!nativePick) { input.current?.click(); return; }
    const ticket = ++version.current; setBusy(true); setError('');
    try {
      const selection = await nativePick({ title: `选择${label}`, extensions });
      if (mounted.current && ticket === version.current && selection) accept(selection);
    } catch (cause) {
      if (mounted.current && ticket === version.current) setError(cause instanceof Error ? cause.message : '来源文件选择失败。');
    } finally { if (mounted.current && ticket === version.current) setBusy(false); }
  }
  return <div className={`reference-file-field${chkCompact?' reference-file-field-compact':''}${dragging ? ' is-dragging' : ''}`} data-testid="reference-file-field"
    onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); acceptFiles(Array.from(event.dataTransfer.files)); }}>
    <div className="reference-file-row"><label className="field" htmlFor={id}>{chkCompact?<span className="reference-compact-label">{label}</span>:label}<input id={id} aria-label={label} aria-describedby={noteId} aria-invalid={!!validationMessage || !!error} placeholder={placeholder} value={value} disabled={disabled} onChange={event => change(event.target.value)} /></label>
      <button type="button" className="reference-file-pick" disabled={disabled || busy} onClick={() => void choose()} aria-label={`选择${label}`}><FileInput size={14} />{busy ? '选择中…' : chkCompact?'选择':'选择文件'}</button>
      {chkCompact&&selected?.path&&<button type="button" className="reference-file-pick" title={selected.path} aria-label="使用本地绝对路径" disabled={disabled||value===selected.path} onClick={()=>{if(selected.path)change(selected.path);}}>绝对路径</button>}
      {chkCompact&&selected&&value!==selected.name&&<button type="button" className="reference-file-pick" aria-label="仅使用文件名" disabled={disabled} onClick={()=>change(selected.name)}>文件名</button>}
    </div>
    <input ref={input} hidden type="file" aria-label={`浏览${label}`} accept={extensions.map(extension => '.' + extension).join(',')} onChange={event => { acceptFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    <div id={noteId} className={chkCompact?'reference-compact-label':'reference-file-note'}>{chkCompact?'填写文件名或运行绝对路径，也可拖入CHK。':<>可填写运行文件名或目标运行路径，也可拖入 {extensions.map(extension => '.' + extension).join(' / ')}。选择或拖入默认使用文件名。</>}</div>
    {!chkCompact&&selected && <div className="reference-local-selection"><span title={selected.path}>本地已选：{selected.path || selected.name}</span>{selected.path && <button type="button" className="text-button" disabled={disabled || value === selected.path} onClick={() => { if (selected.path) change(selected.path); }}>使用本地绝对路径</button>}{value !== selected.name && <button type="button" className="text-button" disabled={disabled} onClick={() => change(selected.name)}>仅使用文件名</button>}</div>}
    {!chkCompact&&absoluteReferencePath(value) && <p className="reference-file-note reference-path-note">绝对路径将原样写入输入；请确认它属于实际运行环境。Windows 本地路径不会转换为 Linux 路径。</p>}
    {error && <DismissibleNotice className="reference-file-error" role="alert">{error}</DismissibleNotice>}
    {validationMessage && <DismissibleNotice className="reference-file-error" role="alert">{validationMessage}</DismissibleNotice>}
  </div>;
}
