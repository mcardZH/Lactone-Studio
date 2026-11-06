import { useEffect, useState } from 'react';
import ModelDocumentDeck, { type ModelDocumentDeckMode } from '../modeling/ModelDocumentDeck';
import PostprocessPlot from './PostprocessPlot';
import type { PostprocessPlotSnapshot } from './PostprocessPresentation';
import type { InteractionScatterSnapshot } from './interaction-controls-contracts';
import InteractionScatterWindow from './InteractionScatterWindow';
import type { HirshfeldFingerprintSnapshot } from './hirshfeld-controls-contracts';
import HirshfeldFingerprintWindow from './HirshfeldFingerprintWindow';
import {FilePathEnergyPlot} from './PostprocessFileInformation';
import {matchesFilePathPlotScope,type FilePathPlotScope,type FilePathPlotSnapshot} from './file-path-plot';
import './Postprocess.css';

export interface InteractionPlotWindowSnapshot extends InteractionScatterSnapshot {
  id: string; kind: 'interaction-scatter'; title: string; source: PostprocessPlotSnapshot['source']; resultId: string; jobIndex: number; frameIndex: number;
}
export interface HirshfeldPlotWindowSnapshot extends HirshfeldFingerprintSnapshot {
  id: string; kind: 'hirshfeld-fingerprint'; title: string; source: PostprocessPlotSnapshot['source']; resultId: string; jobIndex: number; frameIndex: number;
}
export interface PostprocessPlotDeckProps {
  snapshots: readonly (PostprocessPlotSnapshot | InteractionPlotWindowSnapshot | HirshfeldPlotWindowSnapshot | FilePathPlotSnapshot)[]; onClose(id: string): void; active?: boolean;
  /** Undefined shows all sources; null means the current context has no plots. */
  visibleResultId?: string | null;
  visibleFilePlotScope?: FilePathPlotScope | null;
}
/** All snapshots keep one mounted content slot. Visibility is presentation-only:
 * minimize, source changes and module navigation do not recreate the chart. */
export default function PostprocessPlotDeck({ snapshots, onClose, active = true, visibleResultId, visibleFilePlotScope }: PostprocessPlotDeckProps) {
  const [minimized, setMinimized] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState(''), [order, setOrder] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, ModelDocumentDeckMode>>({}), [arrangeRequest, setArrangeRequest] = useState(0);
  const resultScope = visibleResultId === undefined ? 'all' : visibleResultId === null ? 'none' : `result:${visibleResultId}`;
  const scope = visibleFilePlotScope ? JSON.stringify([resultScope,visibleFilePlotScope]) : resultScope;
  const mode = modes[scope] ?? 'free';
  const setMode = (value: ModelDocumentDeckMode) => setModes(before => ({ ...before, [scope]: value }));
  const ids = JSON.stringify(snapshots.map(snapshot => snapshot.id));
  useEffect(() => {
    const known = new Set<string>(JSON.parse(ids));
    setMinimized(before => [...before].some(id => !known.has(id)) ? new Set([...before].filter(id => known.has(id))) : before);
    setOrder(before => before.some(id => !known.has(id)) ? before.filter(id => known.has(id)) : before);
  }, [ids]);
  const ordered = [...snapshots].sort((a, b) => {
    const left = order.indexOf(a.id), right = order.indexOf(b.id);
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
  });
  const visible = ordered.filter(snapshot => snapshot.kind==='file-path'
    ? matchesFilePathPlotScope(snapshot,visibleFilePlotScope)
    : visibleResultId === undefined || snapshot.resultId === visibleResultId);
  const shown = visible.filter(snapshot => !minimized.has(snapshot.id));
  const currentId = shown.some(snapshot => snapshot.id === activeId) ? activeId : shown.at(-1)?.id ?? '';
  function minimize(id: string, value: boolean) {
    setMinimized(before => { const next = new Set(before); if (value) next.add(id); else next.delete(id); return next; });
    if (!value) setActiveId(id);
  }
  return <div className="postprocess-plot-deck" aria-label="后处理内部图窗" hidden={!active || !visible.length}>
    <ModelDocumentDeck activeId={currentId} mode={mode} onActivate={setActiveId} onReorder={setOrder} arrangeRequest={arrangeRequest} layoutKey={scope}
      documents={ordered.map(snapshot => ({ id: snapshot.id, label: snapshot.title, handleContent: snapshot.title,
        headerActions: <><button type="button" aria-label={`最小化${snapshot.title}`} onClick={() => minimize(snapshot.id, true)}>−</button><button type="button" aria-label={`关闭${snapshot.title}`} onClick={() => onClose(snapshot.id)}>×</button></>,
        docked: active && visible.includes(snapshot) && !minimized.has(snapshot.id),
        content: <section className="postprocess-plot-window" data-plot-id={snapshot.id} aria-label={`${snapshot.title} · ${snapshot.source.name}`}>
          <div className="postprocess-window-body"><p className="postprocess-note postprocess-source-name">固定来源：{snapshot.source.name} · {snapshot.kind==='file-path'
            ? snapshot.jobIndex===null?'未关联作业':`作业 ${snapshot.jobIndex+1}`
            : `作业 ${snapshot.jobIndex+1} · 帧 ${snapshot.frameIndex+1}`}</p>{snapshot.kind==='file-path'
            ? <FilePathEnergyPlot snapshot={snapshot}/> : snapshot.kind === 'interaction-scatter'
            ? <InteractionScatterWindow snapshot={snapshot}/> : snapshot.kind === 'hirshfeld-fingerprint' ? <HirshfeldFingerprintWindow snapshot={snapshot}/>
            : <PostprocessPlot snapshot={snapshot}/>}</div>
        </section>,
      }))}/>
    {visible.length > 0 && <div className="postprocess-window-tray"><div className="postprocess-window-tray-controls"><button type="button" onClick={() => { setMode('tiled'); setArrangeRequest(value => value + 1); }}>平铺图窗</button>
      <select aria-label="图窗排列方式" value={mode} onChange={event => setMode(event.target.value as 'free' | 'tiled')}><option value="free">自由排布</option><option value="tiled">规整平铺</option></select>
      </div><div className="postprocess-window-tabs" role="group" aria-label="已打开图窗">{visible.map(snapshot => <button type="button" key={snapshot.id} aria-label={`还原图窗 ${snapshot.title} · ${snapshot.source.name}`} title={`${snapshot.title} · ${snapshot.source.name}`} aria-pressed={!minimized.has(snapshot.id)} onClick={() => minimize(snapshot.id, !minimized.has(snapshot.id))}>{snapshot.title} · {snapshot.source.name}</button>)}</div>
    </div>}
  </div>;
}
