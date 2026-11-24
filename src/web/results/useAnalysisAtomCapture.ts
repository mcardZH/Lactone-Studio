import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Structure,Vector3 } from '../../core/types';
import { pickerStructureIdentity } from '../../core/geometry-guides';
import { inputSelectionIndices } from '../../core/input-selection';
import type { AnalysisSelectionHandle, AnalysisSelectionIntent, AnalysisSelectionPort } from '../analysis-selection-intent';
import type { AnalysisAtomCapture } from '../modeling/ModelViewport';

export interface AnalysisAtomCaptureOptions {
  ownerId: string; structure: Structure; documentId: string; revision: number;
  sourceId: string; sourceRevision?: string | number | null; jobIndex?: number;
  frameIndex: number; activationEpoch: string | number; active: boolean;
  purpose?: AnalysisSelectionIntent['purpose'];
  /** A published trajectory supplies the source revision and exact frame.
   * Validate its geometry when a capture starts, and while a capture is open. */
  lazyStructureIdentity?: boolean;
  onError?(message: string): void;
}
export interface AnalysisCaptureTarget {
  contextKey: string;
  structure: Structure;
  label?: string;
  /** Exact optional PES origin for display annotations during a capture preview. */
  displayGeometry?:import('../../modeling/pes/contracts').PesGeometry;
  assertCurrent(): void;
}
interface Session { id: string; key: string; generation: number; intent: AnalysisSelectionIntent; ids: string[]; images?:Vector3[]; target?: AnalysisCaptureTarget; geometryIdentity?:string }

function notifyDraft(target:Session){
  if(target.images)target.intent.onDraftChange?.([...target.ids],structuredClone(target.images));
  else target.intent.onDraftChange?.([...target.ids]);
}

/** Ephemeral analysis draft only: deliberately has no Store or input-task port. */
export function useAnalysisAtomCapture(options: AnalysisAtomCaptureOptions): {
  selectionPort: AnalysisSelectionPort; viewportCapture: AnalysisAtomCapture | undefined;
  target?: AnalysisCaptureTarget;
  requestSelection(intent:AnalysisSelectionIntent,target?:AnalysisCaptureTarget):AnalysisSelectionHandle;
  cancel(): void;
} {
  const identity = useRef<{ structure: Structure; value: string } | null>(null);
  function geometryIdentity(structure:Structure) {
    if (identity.current?.structure !== structure) identity.current = { structure, value: pickerStructureIdentity(structure) };
    return identity.current.value;
  }
  if (!options.active) identity.current = null;
  const key = JSON.stringify([options.ownerId, options.purpose ?? 'surface-region', options.documentId, options.revision, options.sourceId, options.sourceRevision,
    options.jobIndex, options.frameIndex, options.activationEpoch,
    !options.active ? 'inactive' : options.lazyStructureIdentity ? 'published-frame' : geometryIdentity(options.structure)]);
  const latest = useRef({ options, key, generation: 0 });
  const alive = useRef(true), serial = useRef(0), session = useRef<Session | null>(null);
  const currentSession=session.current;
  const captureGeometryChanged=options.active&&currentSession?.generation===latest.current.generation&&
    currentSession.geometryIdentity!==undefined&&currentSession.geometryIdentity!==geometryIdentity(options.structure);
  // An A -> B -> A return cannot revive a handle, even before effect cleanup.
  if (latest.current.key !== key || latest.current.options.active !== options.active || captureGeometryChanged) latest.current.generation++;
  latest.current.options = options; latest.current.key = key;
  const [snapshot, setSnapshot] = useState<{ session: Session; ids: string[] } | null>(null);
  function assertContext(expectedKey = key, generation = latest.current.generation) {
    const current = latest.current;
    if (!alive.current || !current.options.active || !current.options.ownerId.trim() || !current.options.documentId || !current.options.sourceId ||
      current.key !== expectedKey || current.generation !== generation) throw new Error('分析选择的文档、帧或激活状态已变化，请重新选择。');
  }
  function assertGeometry(target:Session) {
    if (target.geometryIdentity !== undefined && target.geometryIdentity !== geometryIdentity(latest.current.options.structure))
      throw Error('分析选择的几何已变化，请重新选择。');
  }
  function end(target: Session | null, result: 'confirmed' | 'cancelled') {
    if (!target || session.current !== target) return;
    session.current = null;
    if (alive.current) setSnapshot(null);
    target.intent.onEnd?.(result);
  }
  const cancel = useMemo(() => () => end(session.current, 'cancelled'), []);
  const generation = latest.current.generation;
  const requestSelection=useMemo(()=>(intent:AnalysisSelectionIntent,targetSource?:AnalysisCaptureTarget):AnalysisSelectionHandle=>{
      assertContext(key, generation);
      targetSource?.assertCurrent();
      const expectedPurpose=latest.current.options.purpose??'surface-region';
      const kindAllowed=expectedPurpose==='advanced-region'?(intent.kind==='atoms'||intent.kind==='coordinate'):intent.kind===(expectedPurpose==='advanced-coordinate'?'coordinate':'atoms');
      if (intent.owner.kind !== 'analysis' || intent.owner.id !== latest.current.options.ownerId || intent.contextKey !== (targetSource?.contextKey??key) || intent.purpose !== expectedPurpose || !kindAllowed)
        throw new Error('分析选择请求与当前分析实例不匹配。');
      const structure=targetSource?.structure??latest.current.options.structure;
      inputSelectionIndices(structure,intent.initialAtomIds);
      cancel();
      const target:Session={id:`analysis-capture-${++serial.current}`,key,generation,intent,ids:[...intent.initialAtomIds],target:targetSource,
        ...(latest.current.options.lazyStructureIdentity ? {geometryIdentity:geometryIdentity(latest.current.options.structure)} : {})};
      session.current=target;
      const assertCurrent=()=>{assertContext(key,generation);if(session.current!==target)throw Error('分析选择已结束或被替换，请重新选择。');assertGeometry(target);targetSource?.assertCurrent();};
      if(!targetSource||intent.origin==='interactive')setSnapshot({session:target,ids:[...target.ids]});
      try{notifyDraft(target);}catch(error){end(target,'cancelled');throw error;}
      return {assertCurrent,cancel:()=>end(target,'cancelled'),setAtomIds(ids){
        assertCurrent();inputSelectionIndices(structure,ids);
        if(ids.length!==target.ids.length||ids.some((id,index)=>id!==target.ids[index]))target.images=undefined;
        target.ids=[...ids];if(!targetSource||intent.origin==='interactive')setSnapshot({session:target,ids:[...ids]});notifyDraft(target);
      },confirm(){
        assertCurrent();inputSelectionIndices(structure,target.ids);
        if(!target.ids.length)throw Error('请至少选择一个原子。');
        if(intent.kind==='coordinate'&&(target.ids.length<2||target.ids.length>4))throw Error('请按顺序选择2、3或4个不同原子。');
        const confirmed=target.images?intent.onConfirm([...target.ids],structuredClone(target.images)):intent.onConfirm([...target.ids]);
        if(confirmed!==false)end(target,'confirmed');
      }};
  },[key,generation,cancel]);
  const selectionPort = useMemo<AnalysisSelectionPort>(() => ({
    owner: { kind: 'analysis', id: options.ownerId }, contextKey: key,
    assertCurrent: () => assertContext(key, generation),
    requestSelection:intent=>requestSelection(intent),
  }), [key, generation, requestSelection]);
  useLayoutEffect(() => {
    const current=latest.current;
    if (session.current && (session.current.key !== current.key || session.current.generation !== current.generation || !current.options.active)) cancel();
    try{if(session.current){assertGeometry(session.current);session.current.target?.assertCurrent();}}catch{cancel();}
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancel(); };
  }, []);
  const viewportCapture = useMemo<AnalysisAtomCapture | undefined>(() => {
    const target = snapshot?.session;
    if (!target || session.current !== target || target.key !== key || target.generation !== generation || !options.active) return undefined;
    const assertCurrent = () => { assertContext(key, generation); if (session.current !== target) throw new Error('分析选择已结束或被替换，请重新选择。');assertGeometry(target);target.target?.assertCurrent(); };
    const draft = (ids: string[],images?:Vector3[]) => {
      assertCurrent(); inputSelectionIndices(target.target?.structure??latest.current.options.structure, ids);
      target.ids = [...ids];target.images=images&&structuredClone(images);setSnapshot({session:target,ids:[...ids]});notifyDraft(target);
    };
    return { requestId: target.id, ownerId: latest.current.options.ownerId, contextKey: target.intent.contextKey, atomIds: snapshot.ids,kind:target.intent.kind,
      assertCurrent, onCancel: () => end(target, 'cancelled'),
      onPick(id) { draft(id === null ? [] : target.ids.includes(id) ? target.ids.filter(value => value !== id) : [...target.ids, id]); },
      onBox(ids) { if(target.intent.kind==='atoms')draft([...new Set([...target.ids, ...ids])]); },
      onCoordinate(ids,images) { if(target.intent.kind==='coordinate')draft(ids,images); },
    };
  }, [key, generation, snapshot, options.active]);
  const target=viewportCapture?snapshot?.session.target:undefined;
  return useMemo(() => ({ selectionPort, viewportCapture, requestSelection, target, cancel }), [selectionPort, viewportCapture, requestSelection, target, cancel]);
}
