import { useState } from 'react';
import ModelDocumentDeck from '../modeling/ModelDocumentDeck';
import type { InteractionScatterSnapshot } from './interaction-controls-contracts';
import InteractionScatterWindow from './InteractionScatterWindow';
import {ResultsMcpPlotScope} from './results-mcp-context';

export interface StructureInteractionScatterSnapshot extends InteractionScatterSnapshot {
  id: string; title: string; modelName: string;
}

/** Same native plot-window shell, with a real model source and no invented job/frame. */
export default function InteractionStructureScatterDeck({ snapshots, onClose, active,ownerId }: {
  snapshots: readonly StructureInteractionScatterSnapshot[]; onClose(id: string): void; active: boolean;ownerId?:string;
}) {
  const [activeId, setActiveId] = useState('');
  const [order, setOrder] = useState<readonly string[]>([]);
  const ordered = [...snapshots].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
  });
  const currentId=snapshots.some(value=>value.id===activeId)?activeId:snapshots.at(-1)?.id??'';
  return <div className="postprocess-plot-deck" aria-label="结构相互作用图窗" hidden={!active || !snapshots.length}>
    <ModelDocumentDeck activeId={currentId}
      mode="free" onActivate={setActiveId} onReorder={setOrder} documents={ordered.map(snapshot => ({
        id: snapshot.id, label: snapshot.title, handleContent: snapshot.title, docked: active,
        headerActions: <button type="button" aria-label={`关闭${snapshot.title}`} onClick={() => onClose(snapshot.id)}>×</button>,
        content: <section className="postprocess-plot-window" data-plot-id={snapshot.id} aria-label={`${snapshot.title} · ${snapshot.modelName}`}>
          <div className="postprocess-window-body"><p className="postprocess-note postprocess-source-name">固定模型：{snapshot.modelName}</p>
            <ResultsMcpPlotScope scope={{id:snapshot.id,kind:'interaction-scatter',ownerId,analysisSourceKey:snapshot.analysisSourceKey,display:{eligible:active,visible:active,active:active&&currentId===snapshot.id,activate:()=>setActiveId(snapshot.id),close:()=>onClose(snapshot.id)}}}><InteractionScatterWindow snapshot={snapshot}/></ResultsMcpPlotScope></div>
        </section>,
      }))}/>
  </div>;
}
