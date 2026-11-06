import { useState } from 'react';
import ModelDocumentDeck from '../modeling/ModelDocumentDeck';
import type { InteractionScatterSnapshot } from './interaction-controls-contracts';
import InteractionScatterWindow from './InteractionScatterWindow';

export interface StructureInteractionScatterSnapshot extends InteractionScatterSnapshot {
  id: string; title: string; modelName: string;
}

/** Same native plot-window shell, with a real model source and no invented job/frame. */
export default function InteractionStructureScatterDeck({ snapshots, onClose, active }: {
  snapshots: readonly StructureInteractionScatterSnapshot[]; onClose(id: string): void; active: boolean;
}) {
  const [activeId, setActiveId] = useState('');
  const [order, setOrder] = useState<readonly string[]>([]);
  const ordered = [...snapshots].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
  });
  return <div className="postprocess-plot-deck" aria-label="结构相互作用图窗" hidden={!active || !snapshots.length}>
    <ModelDocumentDeck activeId={snapshots.some(value => value.id === activeId) ? activeId : snapshots.at(-1)?.id ?? ''}
      mode="free" onActivate={setActiveId} onReorder={setOrder} documents={ordered.map(snapshot => ({
        id: snapshot.id, label: snapshot.title, handleContent: snapshot.title, docked: active,
        headerActions: <button type="button" aria-label={`关闭${snapshot.title}`} onClick={() => onClose(snapshot.id)}>×</button>,
        content: <section className="postprocess-plot-window" data-plot-id={snapshot.id} aria-label={`${snapshot.title} · ${snapshot.modelName}`}>
          <div className="postprocess-window-body"><p className="postprocess-note postprocess-source-name">固定模型：{snapshot.modelName}</p>
            <InteractionScatterWindow snapshot={snapshot}/></div>
        </section>,
      }))}/>
  </div>;
}
