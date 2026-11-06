import type { AttachmentPort } from '../../modeling/contracts';
import type { Structure, Vector3 } from '../types';

/** Construction metadata only. It must never be sent as a virtual atom/bond. */
export function validateAttachmentPorts(ports: readonly AttachmentPort[] | undefined, structure: Structure): void {
  if (ports === undefined) return;
  if (!Array.isArray(ports)) throw new Error('建模端口数组无效或超限。');
  const atoms = new Set(structure.atoms.map(atom => atom.id)), ids = new Set<string>();
  for (const port of ports) {
    if (!port || typeof port.id !== 'string' || !port.id || port.id.length > 200 || ids.has(port.id) || atoms.has(port.id)
      || typeof port.hostAtomId !== 'string' || !atoms.has(port.hostAtomId)) throw new Error('建模端口身份或宿主无效。');
    if (!Array.isArray(port.direction) || port.direction.length !== 3 || !port.direction.every(Number.isFinite)
      || Math.abs(Math.hypot(...port.direction) - 1) > 1e-6 || ![1, 1.5, 2, 3].includes(port.order)
      || !Number.isFinite(port.displayLength) || port.displayLength <= 0 || port.displayLength > 10) throw new Error('建模端口方向、键级或长度无效。');
    if ([port.presetId, port.slotId].some(value => value !== undefined && (typeof value !== 'string' || !value || value.length > 200))) throw new Error('建模端口来源无效。');
    if (Object.keys(port).some(key => !['id', 'hostAtomId', 'direction', 'order', 'displayLength', 'presetId', 'slotId'].includes(key))) throw new Error('建模端口含未知字段。');
    ids.add(port.id);
  }
}

export function rotateAttachmentDirection(direction: Vector3, axis: Vector3, degrees: number): Vector3 {
  const length = Math.hypot(...axis);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error('端口旋转轴无效。');
  const n = axis.map(value => value / length) as Vector3, radians = degrees * Math.PI / 180;
  const c = Math.cos(radians), s = Math.sin(radians), dot = n.reduce((sum, value, i) => sum + value * direction[i], 0);
  const cross: Vector3 = [n[1] * direction[2] - n[2] * direction[1], n[2] * direction[0] - n[0] * direction[2], n[0] * direction[1] - n[1] * direction[0]];
  return direction.map((value, i) => { const result=value * c + cross[i] * s + n[i] * dot * (1 - c);return result===0?0:result; }) as Vector3;
}

/** Carry construction directions with a rigidly moved branch. One-point moves
 * are translations; collinear branches use the minimal proper rotation. */
export function transportAttachmentPorts(ports: readonly AttachmentPort[], before: Structure, after: Structure, touchedIds: readonly string[]): AttachmentPort[] {
  const moved=new Set(touchedIds), originals=new Map(before.atoms.map(a=>[a.id,a])), next=new Map(after.atoms.map(a=>[a.id,a]));
  const pos=(a:Structure['atoms'][number]):Vector3=>[a.x,a.y,a.z];
  const sub=(a:Vector3,b:Vector3):Vector3=>a.map((v,i)=>v-b[i]) as Vector3;
  const dot=(a:Vector3,b:Vector3)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
  const cross=(a:Vector3,b:Vector3):Vector3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const unit=(v:Vector3):Vector3=>v.map(x=>x===0?0:x/Math.hypot(...v)) as Vector3;
  return ports.map(port=>{
    if(!moved.has(port.hostAtomId))return {...port,direction:[...port.direction]};
    const oldHost=originals.get(port.hostAtomId),host=next.get(port.hostAtomId);if(!oldHost||!host)return {...port,direction:[...port.direction]};
    const pairs=touchedIds.flatMap(id=>{const a=originals.get(id),b=next.get(id);if(id===port.hostAtomId||!a||!b)return [];const v=sub(pos(a),pos(oldHost)),w=sub(pos(b),pos(host));return Math.hypot(...v)>1e-8&&Math.hypot(...w)>1e-8?[{v:unit(v),w:unit(w)}]:[];});
    if(!pairs.length)return {...port,direction:[...port.direction]};
    const first=pairs[0],second=pairs.find(pair=>Math.hypot(...cross(first.v,pair.v))>1e-6&&Math.hypot(...cross(first.w,pair.w))>1e-6);
    if(second){
      const b=unit(sub(second.v,first.v.map(v=>v*dot(first.v,second.v)) as Vector3)),y=unit(sub(second.w,first.w.map(v=>v*dot(first.w,second.w)) as Vector3));
      const c=cross(first.v,b),z=cross(first.w,y),d=port.direction;
      return {...port,direction:unit(first.w.map((v,i)=>v*dot(first.v,d)+y[i]*dot(b,d)+z[i]*dot(c,d)) as Vector3)};
    }
    const axis=cross(first.v,first.w),cos=Math.max(-1,Math.min(1,dot(first.v,first.w)));
    if(Math.hypot(...axis)>1e-8)return {...port,direction:rotateAttachmentDirection(port.direction,axis,Math.acos(cos)*180/Math.PI)};
    if(cos>0)return {...port,direction:[...port.direction]};
    const perpendicular=cross(first.v,Math.abs(first.v[0])<.8?[1,0,0]:[0,1,0]);
    return {...port,direction:rotateAttachmentDirection(port.direction,perpendicular,180)};
  });
}

export interface LocalAttachmentTransport { ports: AttachmentPort[]; warnings: string[] }

/** Automatic XYZ frames transport a construction convention, not an observed
 * physical rotation. Stable-ID sorted real neighbours define each host's own
 * proper orthogonal frame; no selected/movable or remote component is an anchor.
 * This deliberately does not change the manual rigid-branch helper above. */
export function transportLocalAttachmentPorts(ports: readonly AttachmentPort[], before: Structure, after: Structure): LocalAttachmentTransport {
  validateAttachmentPorts(ports, before);
  const oldAtoms = new Map(before.atoms.map(atom => [atom.id!, atom]));
  const newAtoms = new Map(after.atoms.map(atom => [atom.id!, atom]));
  const neighbours = new Map<string, Set<string>>();
  const periodicHosts = new Set<string>();
  for (const bond of before.bonds ?? []) {
    if (bond.order === .5) continue;
    const a = before.atoms[bond.a]?.id, b = before.atoms[bond.b]?.id;
    if (!a || !b) continue;
    if (bond.image?.some(Boolean)) { periodicHosts.add(a); periodicHosts.add(b); continue; }
    if (a === b) continue;
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b); neighbours.get(b)!.add(a);
  }
  const dot = (a: Vector3, b: Vector3) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (v: Vector3): Vector3 => { const length = Math.hypot(...v); return v.map(value => value === 0 ? 0 : value / length) as Vector3; };
  type Basis = [Vector3, Vector3, Vector3];
  type Frame = { old?: Basis; next?: Basis; oldAxis?: Vector3; nextAxis?: Vector3; warning?: string };
  const frames = new Map<string, Frame>();
  function frame(hostId: string): Frame {
    const cached = frames.get(hostId); if (cached) return cached;
    const retain = (reason: string): Frame => { const result = { warning: `宿主 ${hostId} ${reason}，待接端保留原方向。` }; frames.set(hostId, result); return result; };
    const oldHost = oldAtoms.get(hostId), newHost = newAtoms.get(hostId);
    if (!oldHost || !newHost || oldHost.element !== newHost.element) return retain('身份不匹配');
    if (periodicHosts.has(hostId)) return retain('含跨胞连接，不能确定局部方向');
    const ids = [...(neighbours.get(hostId) ?? [])].sort();
    if (!ids.length) return retain('没有真实邻居方向');
    const pairs: { old: Vector3; next: Vector3 }[] = [];
    for (const id of ids) {
      const old = oldAtoms.get(id), next = newAtoms.get(id);
      if (!old || !next || old.element !== next.element) return retain('邻居身份不匹配');
      const a: Vector3 = [old.x - oldHost.x, old.y - oldHost.y, old.z - oldHost.z];
      const b: Vector3 = [next.x - newHost.x, next.y - newHost.y, next.z - newHost.z];
      if (![...a, ...b].every(Number.isFinite) || !Number.isFinite(Math.hypot(...a)) || !Number.isFinite(Math.hypot(...b))
        || Math.hypot(...a) < 1e-8 || Math.hypot(...b) < 1e-8) return retain('邻居向量重合或非有限');
      pairs.push({ old: unit(a), next: unit(b) });
    }
    const first = pairs[0];
    const oldCross = pairs.map(pair => Math.hypot(...cross(first.old, pair.old)));
    const nextCross = pairs.map(pair => Math.hypot(...cross(first.next, pair.next)));
    // Exact rank one has a defined minimal-turn convention. Near-collinearity
    // is not used to amplify a tiny, unstable vector into a new transverse axis.
    const rank = (values: number[]) => { const max = Math.max(...values); return max > 1e-6 ? 2 : max <= 1e-10 ? 1 : 0; };
    const oldRank = rank(oldCross), nextRank = rank(nextCross);
    if (!oldRank || oldRank !== nextRank) return retain('局部方向退化或秩改变');
    let result: Frame;
    if (oldRank === 2) {
      const index = pairs.findIndex((_, i) => oldCross[i] > 1e-6 && nextCross[i] > 1e-6);
      if (index < 0) return retain('没有共同可信的第二方向');
      const basis = (a: Vector3, b: Vector3): Basis => {
        const second = unit(b.map((value, i) => value - a[i] * dot(a, b)) as Vector3);
        return [a, second, cross(a, second)];
      };
      result = { old: basis(first.old, pairs[index].old), next: basis(first.next, pairs[index].next) };
    } else {
      if (pairs.some(pair => Math.sign(dot(first.old, pair.old)) !== Math.sign(dot(first.next, pair.next)))) return retain('共线邻居的方向对应改变');
      result = { oldAxis: first.old, nextAxis: first.next };
    }
    frames.set(hostId, result); return result;
  }
  const warnings = new Set<string>();
  const transported = ports.map(port => {
    const local = frame(port.hostAtomId);
    if (local.warning) { warnings.add(local.warning); return { ...port, direction: [...port.direction] as Vector3 }; }
    let direction: Vector3;
    if (local.old && local.next) {
      // A numerically identity local frame must keep every accepted component
      // verbatim. Mapping through an orthonormal basis and normalizing again
      // would otherwise manufacture a port edit even for no-motion/translation.
      // This is only a round-off check on the construction rotation; model XYZ,
      // content keys and physical revision comparisons remain exact.
      if (local.old.every((axis, i) => axis.every((value, k) => Math.abs(value - local.next![i][k]) <= 1e-12))) return { ...port, direction: [...port.direction] as Vector3 };
      direction = [0, 1, 2].map(i => local.next!.reduce((sum, axis, k) => sum + axis[i] * dot(local.old![k], port.direction), 0)) as Vector3;
    } else {
      const a = local.oldAxis!, b = local.nextAxis!, axis = cross(a, b), sine = Math.hypot(...axis), cosine = Math.max(-1, Math.min(1, dot(a, b)));
      if (sine > 1e-12) direction = rotateAttachmentDirection(port.direction, axis, Math.atan2(sine, cosine) * 180 / Math.PI);
      else if (cosine >= 0) return { ...port, direction: [...port.direction] as Vector3 };
      else {
        // The antiparallel free axis is underdetermined. Use the same bounded,
        // deterministic Cartesian fallback as the existing manual convention.
        const perpendicular = cross(a, Math.abs(a[0]) < .8 ? [1, 0, 0] : [0, 1, 0]);
        direction = rotateAttachmentDirection(port.direction, perpendicular, 180);
      }
    }
    if (!direction.every(Number.isFinite) || Math.hypot(...direction) < 1e-8) {
      warnings.add(`宿主 ${port.hostAtomId} 局部方向计算退化，待接端保留原方向。`);
      direction = [...port.direction];
    } else direction = unit(direction);
    return { ...port, direction };
  });
  validateAttachmentPorts(transported, after);
  return { ports: transported, warnings: [...warnings] };
}
