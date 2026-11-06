export type SceneShapeMethod = 'addArrow' | 'addCylinder' | 'addLine' | 'addSphere' | 'addCustom';
const METADATA_BYTES = 8 * 1024 * 1024, MAX_COMMANDS = 50000;
type Snapshot = { value: any; bytes: number };
type Command = Snapshot & { method: SceneShapeMethod; handle: any; phase: 'base' | 'after'; translateArrow?: boolean };

/** Only small ordinary native specs participate; no getters or serialization. */
function snapshot(value: unknown, maximumNodes = 256): Snapshot | null {
  let nodes = 0, bytes = 0; const stack = new Set<object>();
  const invalid = Symbol();
  function copy(item: any, depth: number): any {
    if (++nodes > maximumNodes || depth > 12) return invalid;
    if (item === null || item === undefined || typeof item === 'boolean') { bytes += 8; return item; }
    if (typeof item === 'number') { bytes += 8; return Number.isFinite(item) ? item : invalid; }
    if (typeof item === 'string') { bytes += 24 + item.length * 2; return item; }
    if (typeof item !== 'object' || stack.has(item)) return invalid;
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (proto !== (array ? Array.prototype : Object.prototype) || Object.getOwnPropertySymbols(item).length) return invalid;
    const keys = Object.keys(item);
    if (Object.getOwnPropertyNames(item).length !== keys.length + Number(array)) return invalid;
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) return invalid;
    bytes += 64 + keys.length * 8; stack.add(item);
    const result: any = array ? [] : {};
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return invalid;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !('value' in property)) return invalid;
      const child = copy(property.value, depth + 1); if (child === invalid) return invalid;
      bytes += key.length * 2; result[key] = child;
    }
    stack.delete(item); return result;
  }
  const copied = copy(value, 0);
  return copied === invalid ? null : { value: copied, bytes };
}
function equal(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a), other = Object.keys(b);
  return keys.length === other.length && keys.every((key, index) => key === other[index] && equal(a[key], b[key]));
}

/** Current sequence only. The layer, not this reconciler, owns native resources. */
export function createSceneSequence(options: {
  create(method: SceneShapeMethod, spec: any): any;
  clear(): void; remove(handles: Iterable<any>): void;
  handles(): Iterable<any>; inventory(): readonly any[] | undefined; size?():number;
  refreshBounds(): void;
  translateArrow?(handle: any, previous: any, next: any): boolean;
}) {
  let records: Command[] = [], next: Command[] = [], owner: string | null = null, appearance: Snapshot | null = null;
  let currentOwner: string | null = null, currentAppearance: Snapshot | null = null, cursor = 0, bytes = 0;
  let active = false, tracking = false, reuse = false, invalidated = false, closed = false, phase: Command['phase'] = 'base';
  let reused = 0, created = 0, retired = 0, retainedBytes = 0, fallback = 'initial';
  let staging=false,baseline=new Set<any>(),staged=new Set<any>(),kept=new Set<any>();
  function orderedTail() {
    const inventory = options.inventory(), handles = [...options.handles()];
    if (!inventory || handles.length !== records.length) return false;
    const live = inventory.filter(Boolean), tail = live.slice(live.length - records.length);
    return tail.length === records.length && records.every((record, index) => tail[index] === record.handle
      && Number.isSafeInteger(record.handle?.shapePosition) && inventory[record.handle.shapePosition] === record.handle);
  }
  function retireRest() {
    if(staging){reuse=false;return;}
    if (reuse) { retired += records.length-cursor; options.remove(records.slice(cursor).map(record => record.handle)); records = records.slice(0, cursor); reuse = false; }
  }
  return {
    begin(identity: string | null, context: unknown, atomic = false) {
      if (closed || active) throw Error('Structural scene sequence is not available.');
      currentOwner = identity; currentAppearance = identity ? snapshot(context, 4096) : null;
      tracking = Boolean(identity && currentAppearance); reuse = tracking && !invalidated && owner === identity
        && appearance !== null && equal(appearance.value, currentAppearance!.value) && orderedTail();
      fallback = reuse ? '' : !identity ? 'unverified-owner' : invalidated ? 'preview-invalidated' : owner !== identity ? 'owner' : !currentAppearance ? 'appearance' : 'order-or-appearance';
      staging=atomic;baseline=new Set(atomic?options.handles():[]);staged.clear();kept.clear();retired=0;
      if (!reuse && !staging) { retired=options.size?.()??records.length; options.clear(); records = []; }
      cursor = 0; next = []; bytes = currentAppearance?.bytes ?? 0; phase = 'base'; active = true; reused = created = 0; invalidated = false;
    },
    create(method: SceneShapeMethod, spec: any, translateArrow = false) {
      if (closed) throw Error('Structural scene sequence is closed.');
      if (!active) {created++;return options.create(method, spec);}
      const captured = tracking && method !== 'addCustom' && spec!==null && typeof spec==='object' && !Array.isArray(spec) ? snapshot(spec) : null;
      const eligible = captured !== null && (captured.value.opacity === undefined || captured.value.opacity === 1)
        && next.length < MAX_COMMANDS && bytes + captured.bytes <= METADATA_BYTES;
      const previous = reuse ? records[cursor] : undefined;
      if (eligible && previous?.phase === phase && previous.method === method && equal(previous.value, captured!.value)) {
        if(staging)kept.add(previous.handle);
        cursor++; bytes += previous.bytes; next.push(previous); reused++; return previous.handle;
      }
      if (!staging && eligible && translateArrow && previous?.translateArrow && previous.phase===phase && previous.method===method
        && options.translateArrow?.(previous.handle,previous.value,captured!.value)) {
        cursor++;bytes+=captured!.bytes;next.push({...captured!,method,handle:previous.handle,phase,translateArrow});reused++;return previous.handle;
      }
      retireRest();
      const handle = options.create(method, spec); created++;
      if(staging&&handle)staged.add(handle);
      if (eligible && handle) { bytes += captured!.bytes; next.push({ ...captured!, method, handle, phase, translateArrow }); }
      else { tracking = false; next = []; invalidated = true; fallback ||= 'unsupported-transparent-or-budget'; }
      return handle;
    },
    beforeFirstRender() { if (!active) return; retireRest(); if(staging){for(const handle of staged)kept.add(handle);const removed=[...baseline].filter(handle=>!kept.has(handle));retired+=removed.length;options.remove(removed);baseline.clear();staging=false;staged.clear();kept.clear();}options.refreshBounds(); phase = 'after'; },
    end() {
      if (!active) return; retireRest(); options.refreshBounds();
      records = tracking ? next : []; retainedBytes=tracking?bytes:0; next = []; owner = tracking ? currentOwner : null; appearance = tracking ? currentAppearance : null; active = false;
    },
    /** Preview replaces only its moving tasks; do not remove static handles. */
    invalidateMetadata() { records = []; next = []; retainedBytes=0; owner = null; appearance = null; invalidated = true; active = tracking = reuse = false; },
    abort(preservePublished=false) {if(preservePublished&&!staging)return;if(staging){try{options.remove(staged);}finally{next=[];staged.clear();baseline.clear();kept.clear();staging=false;active=tracking=reuse=false;options.refreshBounds();}return;}try { options.clear(); } finally { records = []; next = []; retainedBytes=0; reused=created=retired=0; owner = null; appearance = null; active = tracking = reuse = false; invalidated = false; } },
    state: () => ({ retainedCommands: records.length, metadataBytes: retainedBytes, reused, created, retired, fallback }),
    dispose() { if (closed) return; try { options.clear(); } finally { records = []; next = []; retainedBytes=0;reused=created=retired=0; owner = null; appearance = null; active = tracking = reuse = false; closed = true; } },
  };
}
