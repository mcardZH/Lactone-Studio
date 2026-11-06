/** Local scientific-mesh presentation only. Never part of model/global presets. */
export interface MeshFinishSettings { preset: 'matte' | 'soft' | 'glossy' | 'custom'; specular: number; exponent: number; ambient?: number; diffuse?: number; outline?: number; /** Zero/absent preserves the legacy contour. Positive values set its view-normal width. */ outlineWidth?: number }
export const MESH_FINISH_LIMITS = Object.freeze({ ambient: [0, 1] as const, diffuse: [0, 1] as const, specular: [0, 1] as const, exponent: [1, 128] as const });
export const MESH_FINISH_PRESETS = Object.freeze([
  { id:'matte', label:'哑光', specular:0, exponent:48 },
  { id:'soft', label:'柔和高光', specular:.3, exponent:48 },
  { id:'glossy', label:'亮面', specular:.6, exponent:96 },
] as const);
export const DEFAULT_MESH_FINISH: Readonly<MeshFinishSettings> = Object.freeze({ preset:'soft', specular:.3, exponent:48 });
export function normalizeMeshFinish(value?: unknown): MeshFinishSettings {
  const input = value && typeof value==='object' ? value as Partial<MeshFinishSettings> : undefined;
  if (input?.preset === 'custom' && typeof input.specular==='number' && Number.isFinite(input.specular) && input.specular>=0 && input.specular<=1
    && typeof input.exponent==='number' && Number.isFinite(input.exponent) && input.exponent>=1 && input.exponent<=128)
    return { preset:'custom', specular:input.specular, exponent:input.exponent,
      ...Object.fromEntries((['ambient','diffuse','outline','outlineWidth'] as const).flatMap(key=>typeof input[key]==='number'&&Number.isFinite(input[key])&&input[key]!>=0&&input[key]!<=1?[[key,input[key]]]:[])) };
  const preset = MESH_FINISH_PRESETS.find(row=>row.id===input?.preset);
  return preset ? { preset:preset.id, specular:preset.specular, exponent:preset.exponent } : { ...DEFAULT_MESH_FINISH };
}
/** Equivalent numerical finishes do not require any renderer work. The UI
 * separately retains the selected preset/custom editing mode. */
export function meshFinishKey(value?: unknown): string {
  const normalized=normalizeMeshFinish(value); return JSON.stringify([normalized.specular,normalized.exponent,normalized.ambient??.1,normalized.diffuse??.9,normalized.outline??0,...((normalized.outlineWidth??0)>0?[normalized.outlineWidth]:[])]);
}
