import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Structure } from '../../core/types';
import { pickerStructureIdentity } from '../../core/geometry-guides';
import { inputSelectionIndices } from '../../core/input-selection';
import type { AnalysisSelectionIntent, AnalysisSelectionPort } from '../analysis-selection-intent';
import type { AnalysisAtomCapture } from '../modeling/ModelViewport';

export interface AnalysisAtomCaptureOptions {
  ownerId: string; structure: Structure; documentId: string; revision: number;
  sourceId: string; sourceRevision?: string | number | null; jobIndex?: number;
  frameIndex: number; activationEpoch: string | number; active: boolean;
  purpose?: AnalysisSelectionIntent['purpose'];
  onError?(message: string): void;
}
interface Session { id: string; key: string; generation: number; intent: AnalysisSelectionIntent; ids: string[] }

/** Ephemeral analysis draft only: deliberately has no Store or input-task port. */
export function useAnalysisAtomCapture(options: AnalysisAtomCaptureOptions): {
  selectionPort: AnalysisSelectionPort; viewportCapture: AnalysisAtomCapture | undefined; cancel(): void;
} {
  const identity = useRef<{ structure: Structure; value: string } | null>(null);
  // Ordinary frame playback has no capture capability and must not serialize
  // all atoms. Drop the cache so activation always seals the actual geometry.
  if (!options.active) identity.current = null;
  else if (identity.current?.structure !== options.structure) identity.current = { structure: options.structure, value: pickerStructureIdentity(options.structure) };
  const key = JSON.stringify([options.ownerId, options.purpose ?? 'surface-region', options.documentId, options.revision, options.sourceId, options.sourceRevision,
    options.jobIndex, options.frameIndex, options.activationEpoch, identity.current?.value ?? 'inactive']);
  const latest = useRef({ options, key, generation: 0 });
  // An A -> B -> A return cannot revive a handle, even before effect cleanup.
  if (latest.current.key !== key || latest.current.options.active !== options.active) latest.current.generation++;
  latest.current.options = options; latest.current.key = key;
  const alive = useRef(true), serial = useRef(0), session = useRef<Session | null>(null);
  const [snapshot, setSnapshot] = useState<{ session: Session; ids: string[] } | null>(null);
  function assertContext(expectedKey = key, generation = latest.current.generation) {
    const current = latest.current;
    if (!alive.current || !current.options.active || !current.options.ownerId.trim() || !current.options.documentId || !current.options.sourceId ||
      current.key !== expectedKey || current.generation !== generation) throw new Error('分析选择的文档、帧或激活状态已变化，请重新选择。');
  }
  function end(target: Session | null, result: 'confirmed' | 'cancelled') {
    if (!target || session.current !== target) return;
    session.current = null;
    if (alive.current) setSnapshot(null);
    target.intent.onEnd?.(result);
  }
  const cancel = useMemo(() => () => end(session.current, 'cancelled'), []);
  const generation = latest.current.generation;
  const selectionPort = useMemo<AnalysisSelectionPort>(() => ({
    owner: { kind: 'analysis', id: options.ownerId }, contextKey: key,
    assertCurrent: () => assertContext(key, generation),
    requestSelection(intent) {
      assertContext(key, generation);
      const expectedPurpose=latest.current.options.purpose??'surface-region';
      const kindAllowed=expectedPurpose==='advanced-region'?(intent.kind==='atoms'||intent.kind==='coordinate'):intent.kind===(expectedPurpose==='advanced-coordinate'?'coordinate':'atoms');
      if (intent.owner.kind !== 'analysis' || intent.owner.id !== latest.current.options.ownerId || intent.contextKey !== key || intent.purpose !== expectedPurpose || !kindAllowed)
        throw new Error('分析选择请求与当前分析实例不匹配。');
      inputSelectionIndices(latest.current.options.structure, intent.initialAtomIds);
      cancel();
      const target: Session = { id: `analysis-capture-${++serial.current}`, key, generation, intent, ids: [...intent.initialAtomIds] };
      session.current = target;
      const assertCurrent = () => { assertContext(key, generation); if (session.current !== target) throw new Error('分析选择已结束或被替换，请重新选择。'); };
      setSnapshot({ session: target, ids: [...target.ids] });
      try { intent.onDraftChange?.([...target.ids]); } catch (error) { end(target, 'cancelled'); throw error; }
      return {
        assertCurrent, cancel: () => end(target, 'cancelled'),
        confirm() {
          assertCurrent(); inputSelectionIndices(latest.current.options.structure, target.ids);
          if (!target.ids.length) throw new Error('请至少选择一个原子。');
          if(target.intent.kind==='coordinate'&&(target.ids.length<2||target.ids.length>4))throw new Error('请按顺序选择2、3或4个不同原子。');
          if (intent.onConfirm([...target.ids]) !== false) end(target, 'confirmed');
        },
      };
    },
  }), [key, generation, options.active]);
  useLayoutEffect(() => {
    const current=latest.current;
    if (session.current && (session.current.key !== current.key || session.current.generation !== current.generation || !current.options.active)) cancel();
  }, [key, options.active, generation]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancel(); };
  }, []);
  const viewportCapture = useMemo<AnalysisAtomCapture | undefined>(() => {
    const target = snapshot?.session;
    if (!target || session.current !== target || target.key !== key || target.generation !== generation || !options.active) return undefined;
    const assertCurrent = () => { assertContext(key, generation); if (session.current !== target) throw new Error('分析选择已结束或被替换，请重新选择。'); };
    const draft = (ids: string[]) => {
      assertCurrent(); inputSelectionIndices(latest.current.options.structure, ids);
      target.ids = [...ids]; setSnapshot({ session: target, ids: [...ids] }); target.intent.onDraftChange?.([...ids]);
    };
    return { requestId: target.id, ownerId: latest.current.options.ownerId, contextKey: key, atomIds: snapshot.ids,kind:target.intent.kind,
      assertCurrent, onCancel: () => end(target, 'cancelled'),
      onPick(id) { draft(id === null ? [] : target.ids.includes(id) ? target.ids.filter(value => value !== id) : [...target.ids, id]); },
      onBox(ids) { if(target.intent.kind==='atoms')draft([...new Set([...target.ids, ...ids])]); },
      onCoordinate(ids) { if(target.intent.kind==='coordinate')draft(ids); },
    };
  }, [key, generation, snapshot, options.active]);
  return useMemo(() => ({ selectionPort, viewportCapture, cancel }), [selectionPort, viewportCapture, cancel]);
}
