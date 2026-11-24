import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {applyStructureAppearancePreset, STRUCTURE_APPEARANCE_PRESETS} from '../../modeling/appearance-presets';
import type {DisplaySettings} from '../../modeling/contracts';
import {
  applyStructureAppearanceSnapshot, captureStructureAppearance, createDefaultModelDisplay,
  readModelDisplayPreferences, restoreModelDisplayPreferences, writeModelDisplayPreferences,
  type ModelDisplayPreferencesSnapshot,
} from '../../modeling/platform/display-preferences';
import {appearancePreview} from '../appearance-preview-assets';
import {DismissibleNotice} from '../DismissibleNotice';
import {createOffscreenCapture} from '../results/export-image';
import Fragment3DPreview, {fragmentPreviewDocument} from './Fragment3DPreview';
import {APPEARANCE_THUMBNAIL_CAMERA, CAFFEINE_APPEARANCE_SAMPLE, COPPER_APPEARANCE_SAMPLE} from './appearance-preview-structures';

interface Props {
  display: DisplaySettings;
  onChange(display: DisplaySettings): void;
  customOpen: boolean;
  onToggleCustom(): void;
  active: boolean;
  showAxes?: boolean;
  defaultBackgroundColor?: string;
  managePresets?: boolean;
  children: ReactNode;
}

const thumbnailSize = {width:192, height:144};

export default function SettingsStructureAppearance({
  display, onChange, customOpen, onToggleCustom, active, showAxes, defaultBackgroundColor, managePresets = true, children,
}: Props) {
  const [local, setLocal] = useState<ModelDisplayPreferencesSnapshot|null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [name, setName] = useState('');
  const [naming, setNaming] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [tab, setTab] = useState<'built-in'|'personal'>('built-in');
  const [selectedPersonal, setSelectedPersonal] = useState<string>();
  const [galleryOpen, setGalleryOpen] = useState(true);
  const [sample, setSample] = useState(CAFFEINE_APPEARANCE_SAMPLE);
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<string,string>>(new Map());
  const alive = useRef(true);
  const layout = useRef<HTMLDivElement>(null);
  const previewDisplay = useMemo(() => ({
    ...display, backgroundColor: display.backgroundColor ?? defaultBackgroundColor,
  }), [display, defaultBackgroundColor]);
  const personal = local?.namedPresets;
  const saved = personal ?? [];
  const selected = STRUCTURE_APPEARANCE_PRESETS.find(preset => preset.id === display.structurePreset);
  const displayAppearance = JSON.stringify(captureStructureAppearance(display));
  const activeName = saved.find(item => item.name === selectedPersonal && JSON.stringify(item.appearance) === displayAppearance)?.name;
  const similar = saved.find(item => item.name === name.trim());

  async function reload() {
    try {
      const result = await readModelDisplayPreferences();
      if(alive.current) { setLocal(result); setError(result.error ?? ''); }
    } catch (cause) {
      if(alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (active) void reload();
  }, [active]);

  useEffect(() => {
    if(!active || !galleryOpen || tab !== 'personal' || !personal?.length) return;
    const owner = new AbortController();
    const pending = personal.filter(item => !thumbnails.has(JSON.stringify(item.appearance)));
    if(!pending.length) return;
    async function renderSaved() {
      const document = fragmentPreviewDocument(CAFFEINE_APPEARANCE_SAMPLE, undefined, [], 'appearance');
      for(const item of pending) {
        if(owner.signal.aborted) return;
        const key = JSON.stringify(item.appearance);
        let capture: Awaited<ReturnType<typeof createOffscreenCapture>> | undefined;
        try {
          const appearance = applyStructureAppearanceSnapshot(createDefaultModelDisplay(), item.appearance);
          capture = await createOffscreenCapture({
            document, display: appearance, cameraView: APPEARANCE_THUMBNAIL_CAMERA, showAxes: false,
            transparent: true, exactDimensions: true, ...thumbnailSize,
          }, owner.signal, layout.current?.ownerDocument);
          const canvas = await capture.capture(document.draft.structure, document.revision, owner.signal);
          if(!owner.signal.aborted) {
            const image = canvas.toDataURL('image/png');
            setThumbnails(current => new Map(current).set(key,image));
          }
        } catch (cause) {
          if(!owner.signal.aborted) setError(cause instanceof Error ? cause.message : '预设缩略图生成失败。');
        } finally {
          await capture?.dispose();
        }
      }
    }
    void renderSaved().catch(cause => {
      if(!owner.signal.aborted) setError(cause instanceof Error ? cause.message : '预设缩略图生成失败。');
    });
    return () => owner.abort();
    // A completed image adds to the cache without restarting the rest of this queue.
  }, [active, galleryOpen, personal, tab]);

  async function persist(kind:'named'|'default'|'restore') {
    if(!local?.writable || pending) return;
    const trimmed = name.trim();
    if(kind === 'named') {
      if(!trimmed || trimmed.length > 80) { setError('请填写 1–80 个字符的预设名称。'); return; }
      if(STRUCTURE_APPEARANCE_PRESETS.some(item => item.label === trimmed)) {
        setError('内置预设为只读，请使用其他名称。'); return;
      }
      if(similar && !overwrite) { setError('请确认覆盖同名预设，或使用其他名称。'); return; }
    }
    setPending(true);
    setError('');
    setStatus('');
    try {
      const desired = kind === 'named'
        ? [...saved.filter(item => item.name !== trimmed), {name:trimmed, appearance:captureStructureAppearance(display)}]
        : undefined;
      const next = kind === 'restore'
        ? await restoreModelDisplayPreferences(local)
        : await writeModelDisplayPreferences(local, kind === 'named' ? local.display : display, undefined, undefined, desired);
      if(!alive.current) return;
      setLocal(next);
      if(kind === 'named') {
        setStatus('已保存预设');
        setNaming(false);
        setOverwrite(false);
        setSelectedPersonal(trimmed);
        setGalleryOpen(true);
        setTab('personal');
      } else setStatus(kind === 'default' ? '已设为启动默认' : '已恢复内置启动默认');
    } catch (cause) {
      if(alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if(alive.current) setPending(false);
    }
  }

  return <div className="settings-display-pages" ref={layout}>
    <div className="settings-display-controls">
      <div className="sy-settings-card" data-appearance-family="结构" data-selected-preset={selected?.id ?? 'custom'}>
        <div className="sy-settings-fields">
          <button type="button" aria-label="结构选择预设" aria-expanded={galleryOpen} onClick={()=>setGalleryOpen(!galleryOpen)}>选择预设</button>
          <button type="button" aria-label="结构自定义" aria-expanded={customOpen} onClick={onToggleCustom}>自定义</button>
          <span aria-label="结构当前预设">{activeName ?? selected?.label ?? '自定义'}</span>
        </div>
        {galleryOpen && <>
          <div className="settings-appearance-tabs" role="group" aria-label="预设来源">
            <button type="button" aria-pressed={tab==='built-in'} onClick={()=>setTab('built-in')}>内置</button>
            <button type="button" aria-pressed={tab==='personal'} onClick={()=>setTab('personal')}>我的预设</button>
          </div>
          {tab==='built-in' ? <div className="appearance-preset-grid" role="group" aria-label="结构预设">
            {STRUCTURE_APPEARANCE_PRESETS.map(item=><button type="button" key={item.id} className="appearance-preset-card"
              aria-pressed={selected?.id===item.id && !activeName} onClick={()=>{
                setSelectedPersonal(undefined);
                onChange(applyStructureAppearancePreset(display,item.id));
              }}>
              <img className="appearance-preset-preview" src={appearancePreview('structure',item.id)} alt=""/>
              <span>{item.label}</span>
            </button>)}
          </div> : <div className="appearance-preset-grid" role="group" aria-label="我的结构预设">
            {saved.map(item=>{
              const image = thumbnails.get(JSON.stringify(item.appearance));
              return <button type="button" key={item.name} className="appearance-preset-card" aria-pressed={activeName===item.name}
                onClick={()=>{
                  setSelectedPersonal(item.name);
                  onChange(applyStructureAppearanceSnapshot(display,item.appearance));
                }}>
                {image ? <img className="appearance-preset-preview" src={image} alt=""/> : <span className="appearance-preset-preview" aria-hidden="true"/>}
                <span>{item.name}</span>
              </button>;
            })}
            {!saved.length && <span className="settings-appearance-empty">{local?'还没有保存的预设':'正在读取预设…'}</span>}
          </div>}
        </>}
      </div>
      {children}
      {managePresets && <div className="sy-settings-card model-display-default-controls" data-testid="model-display-default-controls"
        data-loaded={!!local} data-writable={!!local?.writable} aria-busy={pending}>
        <div className="sy-settings-fields">
          <button type="button" disabled={!local?.writable||pending} onClick={()=>{setNaming(!naming);setOverwrite(false);}}>保存为预设…</button>
          <button type="button" data-testid="model-save-display-default" disabled={!local?.writable||pending} onClick={()=>void persist('default')}>设为启动默认</button>
          <button type="button" data-testid="model-restore-display-default" disabled={!local?.writable||pending} onClick={()=>void persist('restore')}>恢复内置启动默认</button>
        </div>
        {naming && <form className="settings-preset-name" onSubmit={event=>{event.preventDefault();void persist('named');}}>
          <label>预设名称<input aria-label="结构预设名称" maxLength={80} autoFocus value={name} onChange={event=>{setName(event.currentTarget.value);setOverwrite(false);}}/></label>
          {similar&&<label><input type="checkbox" checked={overwrite} onChange={event=>setOverwrite(event.currentTarget.checked)}/>覆盖同名预设</label>}
          <button type="submit" disabled={pending}>保存</button>
          <button type="button" onClick={()=>setNaming(false)}>取消</button>
        </form>}
        {status && <span role="status">{status}</span>}
        {error && <DismissibleNotice role="alert">{error}</DismissibleNotice>}
        {error && <button type="button" disabled={pending} onClick={()=>void reload()}>重新读取预设</button>}
      </div>}
      {!managePresets && error && <DismissibleNotice role="alert">{error}</DismissibleNotice>}
    </div>
    <aside className="sy-settings-card settings-appearance-preview" aria-label="实时外观预览">
      <div className="settings-appearance-tabs" role="group" aria-label="预览结构">
        <button type="button" aria-pressed={sample===CAFFEINE_APPEARANCE_SAMPLE} onClick={()=>setSample(CAFFEINE_APPEARANCE_SAMPLE)}>分子体系</button>
        <button type="button" aria-pressed={sample===COPPER_APPEARANCE_SAMPLE} onClick={()=>setSample(COPPER_APPEARANCE_SAMPLE)}>周期性体系</button>
      </div>
      <span className="settings-preview-name">{sample.name}</span>
      {active&&<Fragment3DPreview snapshot={sample} sourceKey={sample.id} kind="appearance" display={previewDisplay} showAxes={showAxes} preserveCamera />}
    </aside>
  </div>;
}
