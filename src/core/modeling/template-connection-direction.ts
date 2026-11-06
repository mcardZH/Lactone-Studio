import type { BuilderTemplate } from '../builder-templates';
import type { Vector3 } from '../types';
import { builderPosition, builderVector } from '../builder-geometry';
import { getElementPreset } from './element-presets';
import { templateAmideCarbonyl } from './template-amide-geometry';

const { add, sub, scale, dot, cross } = builderVector;
const unit = (v: Vector3): Vector3 => {
  const length = Math.hypot(...v);
  if (!Number.isFinite(length) || length < 1e-9) throw new Error('片段模板连接方向退化，未提交；请选择其它活性原子。');
  return scale(v, 1 / length);
};

/** A vacant local construction direction, expressed in the immutable template
 * frame. Angles reuse the ordinary builder H policy, not an equilibrium fit.
 * The caller rotates this vacancy onto the actual active-to-host bond. */
export function templateConnectionDirection(template: BuilderTemplate, active: number, exteriorOrder: number): Vector3 | undefined {
  const atom = template.atoms[active], anchor = builderPosition(atom);
  const edges = template.bonds.filter(b => b.a === active || b.b === active);
  if (!edges.length) return undefined;
  if (edges.some(b => b.kind === 'coordination')) throw new Error('模板配位接入缺少明确外部槽方向，未猜测几何。');
  const neighbours = [...new Set(edges.map(b => b.a === active ? b.b : b.a))];
  const vectors = neighbours.map(index => unit(sub(builderPosition(template.atoms[index]), anchor)));
  const aromatic = (b: typeof edges[number]) => !!b.aromatic || b.order === 1.5 || b.order === 4;
  let linear = exteriorOrder === 3 || edges.some(b => !aromatic(b) && b.order >= 3);
  let planar = exteriorOrder === 1.5 || exteriorOrder === 2 || edges.some(b => aromatic(b) || b.order >= 2)
    || atom.element === 'C' && atom.formalCharge === 1 || atom.element === 'B' && (atom.formalCharge ?? 0) >= 0 || !!templateAmideCarbonyl(template, active);
  let cosine = linear ? -1 : planar ? -.5
    : atom.element === 'O' ? Math.cos(((atom.formalCharge ?? 0) > 0 ? 107 : 104.5) * Math.PI / 180)
    : atom.element === 'N' && (atom.formalCharge ?? 0) <= 0 ? Math.cos(((atom.formalCharge ?? 0) < 0 ? 104.5 : 107) * Math.PI / 180) : -1 / 3;
  if (atom.geometryPresetId) {
    const preset = getElementPreset(atom.geometryPresetId);
    if (preset.family !== 'organic' || preset.element !== atom.element || preset.slots.length < vectors.length + 1) throw new Error('模板明确几何缺少可用接入槽，未猜测配位方向。');
    linear = preset.geometry === 'linear';
    planar = ['trigonal-planar', 'bent-planar'].includes(preset.geometry);
    cosine = dot(preset.slots[0].direction, preset.slots[1].direction);
  } else if (!['H','B','C','N','O','F','Si','P','S','Cl','Br','I'].includes(atom.element)) {
    throw new Error('模板活性元素缺少明确接入几何，未猜测方向。');
  }
  if (vectors.length === 1) {
    const u = vectors[0];
    if (linear) return scale(u, -1);
    // A remote atom defines the existing conformational plane when available.
    // Otherwise this azimuth is arbitrary; the final bond-axis torsion search
    // supplies environmental clearance without changing any internal geometry.
    const remote = template.atoms.map((a, index) => index === active || neighbours.includes(index) ? undefined : sub(builderPosition(a), anchor))
      .filter((v): v is Vector3 => !!v).map(v => sub(v, scale(u, dot(v, u)))).find(v => Math.hypot(...v) > 1e-9);
    const basis: Vector3 = Math.abs(u[0]) < .8 ? [1, 0, 0] : [0, 1, 0];
    const tangent = unit(remote ?? sub(basis, scale(u, dot(basis, u))));
    return unit(add(scale(u, cosine), scale(tangent, Math.sqrt(Math.max(0, 1 - cosine * cosine)))));
  }
  if (vectors.length === 2 && !linear && !planar) {
    const [u, v] = vectors, denominator = 1 + dot(u, v);
    if (denominator < 1e-9) throw new Error('片段模板连接方向退化，两个相反邻居不能定义该接入槽。');
    const inPlane = scale(add(u, v), cosine / denominator), remaining = 1 - dot(inPlane, inPlane);
    if (remaining < -1e-9) throw new Error('模板固定夹角与接入槽几何不相容，未扭曲内部构象。');
    const normal = unit(cross(u, v));
    return unit(add(inPlane, scale(normal, Math.sqrt(Math.max(0, remaining)))));
  }
  // Planar two-neighbour seeds (including NO2/phenyl) and complete three-arm
  // tetrahedral seeds (CF3/SiMe3) already encode their construction vacancy.
  // Preserve those measured seed angles instead of flattening or refitting.
  return unit(scale(vectors.reduce<Vector3>(add, [0, 0, 0]), -1));
}
