import type { TrajectoryResult } from '../../results/contracts';
import type { AtomicProperty, ScientificField } from '../../results/scientific-contracts';
import { convertEnergy } from '../../results/energy';
import { frontierOrbitals } from '../../results/scientific-analysis';
import {formatResultValue} from '../../results/numeric-format';

export type PostprocessEnergyUnit = 'eV' | 'hartree';
export const postprocessUnitLabel = (unit: PostprocessEnergyUnit) => unit === 'hartree' ? 'Eh' : 'eV';
export const postprocessStatusLabel = (status?: TrajectoryResult['status']) => status ? ({ completed: '正常完成', incomplete: '未完成', failed: '失败', unknown: '状态未确认' }[status]) : '未载入';
export function postprocessFields(result: TrajectoryResult): ScientificField[] {
  return [...(result.scientific?.summary ?? []), ...(result.scientific?.properties ?? [])];
}
export function postprocessFieldGroups(fields: ScientificField[]) {
  const energy: ScientificField[] = [], dipole: ScientificField[] = [], quadrupole: ScientificField[] = [], traceless: ScientificField[] = [], spin: ScientificField[] = [], other: ScientificField[] = [];
  for (const field of fields) {
    const token = `${field.key} ${field.label}`;
    if (/traceless.*quadrupole|quadrupole.*traceless|无迹.*四极/i.test(token)) traceless.push(field);
    else if (/quadrupole|四极/i.test(token)) quadrupole.push(field);
    else if (/dipole|偶极/i.test(token)) dipole.push(field);
    else if (/\bs2-|s\^?2|s²|annihilation|expectation value.*s|自旋污染/i.test(token)) spin.push(field);
    else if (typeof field.value === 'number' && !/convergence|threshold|settings?|tolerance|收敛|阈值/i.test(token) && /energy|energies|enthalp|gibbs|zero-point|correction|能量|修正|焓/i.test(token)) energy.push(field);
    else other.push(field);
  }
  return { energy, dipole, quadrupole, traceless, spin, other };
}

const energyKeys=new Set(['target-energy','final-energy','excited-total-energy','$act-energy','total-energy','orca-scf-total-energy','scf-energy','scf-energy-reference','mp2-energy','sc-plus-nl-energy','nl-energy-correction','smd-cds-energy-correction','dispersion-energy','gaussian-dispersion-correction','total-energy-after-final-integration','display-potential-energy']);
const thermoKeys=new Set(['temperature','pressure','electronic-energy','zero-point-energy','zero-point-correction','non-thermal-zpe-correction','thermal-vibrational-correction','thermal-rotational-correction','thermal-translational-correction','total-thermal-energy','total-thermal-correction','total-correction','thermal-enthalpy-correction','total-enthalpy','electronic-entropy','vibrational-entropy','rotational-entropy','translational-entropy','final-entropy-term','total-entropy-correction','final-gibbs-free-energy','final-gibbs-free-enthalpy','g-e-el-','thermal-correction-to-energy','thermal-correction-to-enthalpy','thermal-correction-to-gibbs-free-energy','sum-of-electronic-and-zero-point-energies','sum-of-electronic-and-thermal-energies','sum-of-electronic-and-thermal-enthalpies','sum-of-electronic-and-thermal-free-energies']);
const fieldKey=(field:ScientificField)=>field.key.toLowerCase().replace(/[\s_]+/g,'-');
const dispersionField=(field:ScientificField)=>['dispersion-energy','gaussian-dispersion-correction'].includes(fieldKey(field));
function dispersionObservation(result:TrajectoryResult,field:ScientificField):string|null {
  const sourceId=field.sourceId??result.source.id,sourceName=field.sourceName??result.source.name;
  const scope=field as ScientificField&{jobIndex?:unknown;stageId?:unknown;sourceFrameIndex?:unknown};
  if(typeof sourceId!=='string'||!sourceId||typeof sourceName!=='string'||!sourceName||
    field.sourceId!==undefined&&typeof field.sourceId!=='string'||field.sourceName!==undefined&&typeof field.sourceName!=='string'||
    !Number.isInteger(result.jobIndex)||result.jobIndex<0||!Number.isInteger(field.frameIndex)||typeof field.frameIndex!=='number'||field.frameIndex<0||
    !Number.isSafeInteger(field.sourceLine)||field.sourceLine<=0||!field.rawValue||!['hartree','eV'].includes(field.unit??'')||
    scope.jobIndex!==undefined&&!Number.isInteger(scope.jobIndex)||scope.stageId!==undefined&&typeof scope.stageId!=='string'||
    scope.sourceFrameIndex!==undefined&&!Number.isInteger(scope.sourceFrameIndex))return null;
  return JSON.stringify([sourceId,sourceName,result.jobIndex,scope.jobIndex??result.jobIndex,scope.stageId??null,
    scope.sourceFrameIndex??null,field.frameIndex,field.sourceLine,field.rawValue,field.unit,field.value]);
}
/** Main energy view has explicit definitions; raw/audit fields remain intact. */
export function isPostprocessEnergyField(field:ScientificField):boolean {
  const key=fieldKey(field);
  return typeof field.value==='number'&&Number.isFinite(field.value)&&(energyKeys.has(key)||thermoKeys.has(key)||/^energy-(?:eump2|e\((?:rmp2|ump2|ccsd|qcisd|corr)\)|ccsd\(t\)|total-energy,-e\()/i.test(key)||/^(?:total|electronic|translational|rotational|vibrational)-(?:energy|cv|entropy)$/.test(key));
}
export function postprocessFieldLabel(field:ScientificField):string {
  if(field.key==='final-energy'&&['irc-initial-single-point','irc-preparation-single-point','irc-forward','irc-reverse'].includes(field.stageId??''))return field.label;
  const key=fieldKey(field),names:Record<string,string>={
    'display-electronic-energy':'总电子能 E','target-energy':'目标电子能 E','final-energy':'最终单点能 E(FINAL SINGLE POINT)','excited-total-energy':'目标激发态总能量 E*',
    'total-energy':'已打印总能量 E','orca-scf-total-energy':'SCF总能量 E(SCF)','scf-energy':'SCF能量 E(SCF)','scf-energy-reference':'SCF参考能 E(SCF)','mp2-energy':'MP2总能量 E(MP2)',
    'nl-energy-correction':'非局域色散修正 E(NL)','sc-plus-nl-energy':'含非局域修正的电子能 E(SCF+NL)',
    'dispersion-energy':'色散修正 E(disp)','smd-cds-energy-correction':'SMD CDS自由能修正','total-energy-after-final-integration':'最终积分后的电子能',
    'zero-point-energy':'零点振动能 ZPE','zero-point-correction':'零点振动能 ZPE','non-thermal-zpe-correction':'零点振动能 ZPE',
    'thermal-correction-to-energy':'内能热修正','thermal-correction-to-enthalpy':'焓修正','thermal-correction-to-gibbs-free-energy':'吉布斯自由能修正',
    'sum-of-electronic-and-zero-point-energies':'电子能与零点能之和 E+ZPE','sum-of-electronic-and-thermal-energies':'内能 U',
    'sum-of-electronic-and-thermal-enthalpies':'焓 H','sum-of-electronic-and-thermal-free-energies':'吉布斯自由能 G',
    'final-gibbs-free-energy':'吉布斯自由能 G','final-gibbs-free-enthalpy':'吉布斯自由能 G',
    'temperature':'温度 T','pressure':'压力 p','electronic-energy':'电子能 E(el)','total-thermal-energy':'内能 U','total-enthalpy':'焓 H',
    'thermal-vibrational-correction':'振动热修正','thermal-rotational-correction':'转动热修正','thermal-translational-correction':'平动热修正',
    'total-thermal-correction':'总热修正','total-correction':'总能量修正','thermal-enthalpy-correction':'焓热修正','final-entropy-term':'总熵项 TS','total-entropy-correction':'熵修正 −TS','g-e-el-':'吉布斯自由能修正 G−E(el)',
  };
  if(dispersionField(field)){
    const method=field.label.match(/\b(Grimme-D[234](?:\([^)]*\))?)/i)?.[1];
    return `${method?method+' ':''}色散修正 E(disp)`;
  }
  if(key==='display-electronic-energy'||key==='display-potential-energy')return field.label;
  const dipole=key.match(/^(?:dipole-([xyz])(?:-au)?|dipole-moment:([xyz]))$/);
  if(dipole)return `偶极矩 μ${dipole[1]??dipole[2]}`;
  if(['dipole-total','dipole-magnitude','magnitude-debye'].includes(key))return '偶极矩 |μ|';
  if(/^(?:s2|spin-squared)-before$/.test(key))return '湮灭前 ⟨S²⟩';
  if(/^(?:s2|spin-squared)-after$/.test(key))return '湮灭后 ⟨S²⟩';
  if(['spin-squared','expectation-value-of-s**2'].includes(key))return '自旋平方期望值 ⟨S²⟩';
  const quadrupole=key.match(/^(?:quadrupole-(?:ordinary-|traceless-)?|traceless-quadrupole-|quadrupole-moment[:-])([xyz]{2})$/);
  if(quadrupole)return `${/traceless/.test(key)?'无迹四极矩':'四极矩'} Q${quadrupole[1]}`;
  if(/^energy-/.test(key)&&isPostprocessEnergyField(field))return `相关总能量 ${field.label}`;
  const contribution=key.match(/^(total|electronic|translational|rotational|vibrational)-(energy|cv|entropy)$/);
  if(contribution&&!names[key]){const prefix=({total:'总',electronic:'电子',translational:'平动',rotational:'转动',vibrational:'振动'} as Record<string,string>)[contribution[1]];return prefix+({energy:'能量',cv:'定容热容 Cᵥ',entropy:field.unit==='hartree'?'熵项 TS':'熵 S'} as Record<string,string>)[contribution[2]];}
  return names[key]??field.label;
}

/** File roles are concise on screen; complete names/IDs remain on the source field and exports. */
export function postprocessSourceLabel(name: string): string {
  const labels: string[] = [];
  if (/\.(?:out|log)(?:\s*\/\s*|$)/i.test(name)) labels.push('OUT');
  if (/\.(?:fch|fchk)(?:\s*\/\s*|$)/i.test(name)) labels.push('FCHK');
  if (/\.molden(?:\.input)?(?:\s*\/\s*|$)/i.test(name)) labels.push('Molden');
  return labels.length ? labels.join(' / ') : '已载入的输出文件';
}

export function postprocessSolventLabel(solvent: string | number | undefined, model: string | number | undefined, epsilon: string | number | undefined): string | number | undefined {
  if (typeof solvent === 'string' && /^generic$/i.test(solvent.trim()) && typeof epsilon === 'number' && Number.isFinite(epsilon) && typeof model === 'string' && model.trim()) return `${model.trim().replace(/\.$/, '')} eps=${epsilon}`;
  return solvent;
}

/** Collapse aliases of the evaluated electronic energy, never equal-valued corrections. */
export function postprocessEnergyFields(result: TrajectoryResult, frameIndex: number): ScientificField[] {
  const potentialFrame=result.frames[frameIndex];
  if(potentialFrame?.energyQuantity==='potential'){
    const energy=potentialFrame.energy;if(!energy||!Number.isFinite(energy.value))return [];
    // The source reader already admitted this frame's E_Pot. Its printed token
    // may only come from the same XYZ/comment observation, never SCF or Etot.
    const observation=potentialFrame.energyObservations?.find(item=>item.kind==='xyz-comment'&&item.quantity==='potential'&&!item.placeholder&&!item.relative
      &&item.value===energy.value&&item.unit===energy.unit&&item.source.id===result.source.id&&item.source.name===result.source.name);
    return [{key:'display-potential-energy',label:'势能 Epot',value:energy.value,unit:energy.unit,rawValue:observation?.rawValue,
      sourceLine:observation?.source.line??0,sourceId:result.source.id,sourceName:result.source.name,frameIndex,...(observation?.origin?{origin:observation.origin}:{})}];
  }
  const all = [...postprocessFields(result), ...(result.scientific?.thermochemistry ?? [])]
    .filter(field => isPostprocessEnergyField(field)&&(field.frameIndex === frameIndex || field.frameIndex == null));
  const electronicKeys = new Set(['target-energy','excited-total-energy','final-energy','$act_energy','Total Energy','scf-energy','SCF Energy']);
  const frame = result.frames[frameIndex], target = frame?.energy;
  const ranked=['target-energy','excited-total-energy','final-energy','$act_energy','Total Energy','scf-energy','SCF Energy'].flatMap(key=>all.filter(field=>field.key===key&&(field.sourceId??result.source.id)===result.source.id));
  const preferred=target?ranked.find(field=>field.value===target.value&&field.unit===target.unit):ranked[0]??all.find(field=>electronicKeys.has(field.key));
  // A paired FCHK can supply the saved HF/DFT energy even when the OUT omits
  // an evaluated frame energy. Require its own identified method and frame;
  // an arbitrary SCF reference must not become a correlated/excited target.
  const savedMethod=preferred?.key==='SCF Energy'?postprocessFields(result).find(field=>field.key==='method'&&field.frameIndex===frameIndex
    &&(field.sourceId??result.source.id)===(preferred.sourceId??result.source.id))?.value:undefined;
  const savedScfTarget=typeof savedMethod==='string'&&/^(?:[ru]?hf|rohf|[ru]?(?:b3lyp|b3pw91|blyp|bp86|pbe0|pbe1pbe|pbepbe|pbe|m062x|m06-2x|m06|m06l|m052x|m05-2x|tpss|tpssh|camb3lyp|cam-b3lyp|wb97xd|wb97x-d|r2scan|scan))$/i.test(savedMethod.trim())
    &&preferred?.frameIndex===frameIndex&&!/\b(?:td|tda|cis|zindo|oniom|external|casscf|caspt2|ccsd|cisd|qcisd|mp[2345]|b2plyp|doublehybrid|eom|nevpt2)\b/i.test(result.scientific?.route??'');
  const value = target?.value ?? (preferred&&/^(?:scf-energy|SCF Energy)$/.test(preferred.key)&&!savedScfTarget?undefined:preferred?.value), unit = target?.unit ?? preferred?.unit;
  const isScfTarget = Boolean(all.some(field => field.key === 'scf-energy' && field.sourceLine === preferred?.sourceLine && field.sourceId === preferred?.sourceId))
    || /已保存能量：SCF Energy/.test(frame?.label ?? '')
    || /^\s*#[pnt]?\s+(?:[ru]?hf|rohf|[ru]?(?:b3lyp|b3pw91|blyp|bp86|pbe0|pbe1pbe|pbepbe|pbe|m062x|m06-2x|m06|m06l|m052x|m05-2x|tpss|tpssh|camb3lyp|cam-b3lyp|wb97xd|wb97x-d|r2scan|scan))\//i.test(result.scientific?.route ?? '');
  const alias = (field: ScientificField) => electronicKeys.has(field.key) && (!/^(?:scf-energy|SCF Energy)$/.test(field.key) || isScfTarget);
  const same = (field: ScientificField) => typeof value === 'number' && typeof field.value === 'number' && field.unit === unit && Math.abs(field.value - value) <= (unit === 'hartree' ? 5e-10 : 1e-9);
  const duplicates = all.filter(field => alias(field) && same(field));
  // ORCA reprints the final-integration SCF subtotal under TOTAL SCF ENERGY.
  // These explicit aliases are not the dispersion-corrected method target.
  // Require the same source/frame/unit and the adjacent print block, never
  // merge unrelated corrections merely because their displayed values agree.
  const integrationCopies = new Set<ScientificField>();
  if (result.engine === 'orca') for (const field of all) {
    if (field.key !== 'total-energy-after-final-integration' || field.unit !== 'hartree' || typeof field.value !== 'number') continue;
    const full = all.find(other => ['orca-scf-total-energy','total-energy'].includes(other.key) && other.unit === field.unit && other.frameIndex === field.frameIndex
      && (other.sourceId ?? result.source.id) === (field.sourceId ?? result.source.id)
      && (other.sourceName ?? result.source.name) === (field.sourceName ?? result.source.name)
      && other.sourceLine > field.sourceLine && other.sourceLine <= field.sourceLine + 12
      && typeof other.value === 'number' && Math.abs(other.value - (field.value as number)) <= 5e-10);
    if (full) integrationCopies.add(field);
  }
  const rows: ScientificField[] = [];
  const rawSource=[...(preferred?[preferred]:[]),...duplicates,...all.filter(field=>field.key==='excited-total-energy')].find(field=>field.value===value&&field.unit===unit&&field.rawValue!==undefined&&(field.frameIndex===frameIndex||result.frames.length===1&&field.frameIndex==null));
  // Zero marks a synthesized display row without a printed energy observation;
  // the numeric audit leaves that line blank instead of borrowing a geometry line.
  if (typeof value === 'number' && Number.isFinite(value)) rows.push({ ...(preferred ?? { sourceLine: 0 }), key: 'display-electronic-energy', label: preferred?.key==='excited-total-energy'?'目标激发态总能量 E*':result.engine==='orca'&&preferred?.key==='final-energy'?postprocessFieldLabel(preferred):'总电子能 E', value, unit,rawValue:rawSource?.rawValue,
    frameIndex, sourceName: [...new Set(duplicates.map(field => field.sourceName ?? result.source.name))].join(' / ') || preferred?.sourceName || result.source.name });
  const seen = new Set<string>(),dispersionObservations=new Set<string>();
  for (const field of all) {
    if (duplicates.includes(field) || integrationCopies.has(field)) continue;
    if(dispersionField(field)){
      // Alias keys may represent one printed observation. Unknown lineage and
      // distinct printed events never collapse merely because their values agree.
      const identity=dispersionObservation(result,field);
      if(identity&&dispersionObservations.has(identity))continue;
      if(identity)dispersionObservations.add(identity);
      rows.push(field);continue;
    }
    // Thermochemical totals, corrections, SCF reference and distinct values retain their own definitions.
    const identity = JSON.stringify([field.key, field.unit, field.value, field.frameIndex]);
    if (!seen.has(identity)) { rows.push(field); seen.add(identity); }
  }
  return rows;
}

/** Preferred thermochemical rows retain their source values and units. Extras
 * remain available rather than confusing thermal decomposition with Eelec. */
export function postprocessThermochemistryGroups(fields: readonly ScientificField[]): { summary: ScientificField[]; extra: ScientificField[] } {
  const selected = new Set<ScientificField>(), summary: ScientificField[] = [];
  const pick = (keys: readonly string[], label: string) => {
    const row = keys.flatMap(key => fields.filter(field => field.key === key)).at(0);
    if (row) { selected.add(row); summary.push({ ...row, label }); }
    return row;
  };
  const numeric = (key:string) => fields.find(field=>field.key===key&&typeof field.value==='number'&&Number.isFinite(field.value));
  const sameContext=(a:ScientificField,b:ScientificField)=>a.frameIndex===b.frameIndex&&a.sourceId===b.sourceId&&a.sourceName===b.sourceName;
  pick(['display-electronic-energy'], '电子能量 Eelec');
  pick(['temperature'], '温度 T'); pick(['pressure'], '压力 p');
  pick(['zero-point-energy','zero-point-correction','non-thermal-zpe-correction'], '零点振动能 ZPE');
  if(!pick(['total-entropy'], '总熵 S')){
    // ORCA prints T*S in energy units. Do not label that value as entropy.
    const ts=numeric('final-entropy-term'),temperature=numeric('temperature');
    if(ts&&temperature&&temperature.unit==='K'&&(temperature.value as number)>0&&sameContext(ts,temperature)){
      const joules=convertEnergy({value:ts.value as number,unit:ts.unit??''},'kJ/mol');
      if(joules!==null)summary.push({...ts,key:'derived-total-entropy',label:'总熵 S（TS/T）',value:joules*1000/(temperature.value as number),unit:'J/mol/K',rawValue:undefined,sourceLine:0});
    }
  }
  pick(['thermal-correction-to-gibbs-free-energy','g-e-el-'], 'G 校正');
  if(!pick(['thermal-correction-to-enthalpy'], 'H 校正')){
    // ORCA's "Thermal Enthalpy correction" is H-U, not H-Eelec.
    const h=numeric('total-enthalpy'),e=numeric('electronic-energy');
    if(h&&e&&sameContext(h,e)){
      const enthalpy=convertEnergy({value:h.value as number,unit:h.unit??''},'hartree'),electronic=convertEnergy({value:e.value as number,unit:e.unit??''},'hartree');
      if(enthalpy!==null&&electronic!==null)summary.push({...h,key:'derived-enthalpy-correction',label:'H 校正（H−E）',value:enthalpy-electronic,unit:'hartree',rawValue:undefined,sourceLine:0});
    }
  }
  pick(['thermal-correction-to-energy','total-correction'], 'U 校正');
  pick(['sum-of-electronic-and-thermal-free-energies','final-gibbs-free-energy','final-gibbs-free-enthalpy'], '吉布斯自由能 G');
  pick(['sum-of-electronic-and-thermal-enthalpies','total-enthalpy'], '焓 H');
  pick(['sum-of-electronic-and-thermal-energies','total-thermal-energy'], '内能 U');
  return { summary, extra: fields.filter(field => !selected.has(field)) };
}
/** Select one source-consistent dipole set. Saved FCHK atomic units are displayed in Debye. */
export function postprocessDipoleFields(result: TrajectoryResult, frameIndex: number): ScientificField[] {
  const fields=postprocessFieldGroups(postprocessFields(result)).dipole.filter(field=>field.frameIndex===frameIndex||field.frameIndex==null);
  const sourceId=(field:ScientificField)=>field.sourceId??result.source.id;
  const sources=[...new Set(fields.map(sourceId))].sort((a,b)=>Number(b===result.source.id)-Number(a===result.source.id));
  const triples=[['dipole-total-x','dipole-total-y','dipole-total-z'],['dipole-x','dipole-y','dipole-z'],['dipole-X','dipole-Y','dipole-Z'],['dipole-x-au','dipole-y-au','dipole-z-au'],['Dipole Moment:X','Dipole Moment:Y','Dipole Moment:Z']];
  const factorFor=(unit:string|undefined)=>unit==='e·bohr'||unit==='a.u.'?2.541746473:1;
  const magnitudeKeys=['dipole-magnitude-debye','dipole-total','dipole-magnitude','magnitude-debye','dipole-magnitude-au'];
  const magnitudesFor=(source:string,frame:number|null)=>magnitudeKeys.flatMap(key=>fields.filter(field=>field.key===key&&sourceId(field)===source&&(field.frameIndex??null)===frame&&typeof field.value==='number'&&Number.isFinite(field.value)));
  for(const source of sources)for(const frame of [frameIndex,null])for(const keys of triples){
    const components=keys.map(key=>fields.find(field=>field.key===key&&sourceId(field)===source&&(field.frameIndex??null)===frame));
    if(!components.every((field):field is ScientificField=>Boolean(field)&&typeof field!.value==='number'&&Number.isFinite(field!.value)))continue;
    if(!components.every(field=>field.sourceName===components[0].sourceName))continue;
    if(!components.every(field=>field.unit===components[0].unit))continue;
    if(keys[0]==='dipole-total-x'&&!['a.u.','e·bohr','Debye'].includes(components[0].unit??''))continue;
    const factor=factorFor(components[0].unit),unit=factor===1?components[0].unit:'Debye';
    const rows=components.map((field,index)=>({...field,key:`display-dipole-${'xyz'[index]}`,label:`μ${'xyz'[index]}`,value:(field.value as number)*factor,unit}));
    const printed=magnitudesFor(source,frame).find(field=>field.sourceName===components[0].sourceName),total=printed&&(factorFor(printed.unit)===1?printed.unit:'Debye')===unit?printed:undefined;
    rows.push(total?{...total,key:'display-dipole-total',label:'|μ|',value:(total.value as number)*factorFor(total.unit),unit}:{...rows[0],key:'display-dipole-total',label:'|μ|（由XYZ）',value:Math.hypot(...rows.map(field=>field.value))});
    return rows;
  }
  for(const source of sources)for(const frame of [frameIndex,null]){
    const magnitude=magnitudesFor(source,frame)[0];
    if(magnitude)return[{...magnitude,key:'display-dipole-total',label:'|μ|',value:(magnitude.value as number)*factorFor(magnitude.unit),unit:factorFor(magnitude.unit)===1?magnitude.unit:'Debye'}];
  }
  return [];
}
export function preferredPostprocessAtomic(properties: readonly AtomicProperty[], frameIndex: number): AtomicProperty | null {
  const bound = properties.filter(property => property.frameIndex === frameIndex && property.kind === 'charge');
  const mulliken = bound.find(property => /^mulliken$/i.test(property.scheme));
  if (mulliken) return mulliken;
  return new Set(bound.map(property => property.scheme)).size === 1 ? bound[bound.length - 1] ?? null : null;
}
export function postprocessFinalSpinFields(fields: readonly ScientificField[], frameIndex: number): ScientificField[] {
  const final = new Map<string, ScientificField>();
  for (const field of fields) {
    if (/initial|初始/i.test(`${field.key} ${field.label}`) || field.frameIndex !== frameIndex) continue;
    const previous = final.get(field.key);
    if (!previous || field.sourceLine >= previous.sourceLine) final.set(field.key, field);
  }
  return [...final.values()];
}
export function postprocessScfState(result: TrajectoryResult | null, frameIndex: number): { available: boolean; label: string } {
  if (!result) return { available: false, label: '缺输出数据' };
  const cycles = result.scientific?.scfCycles.filter(cycle => cycle.frameIndex === frameIndex) ?? [];
  const available = cycles.some(cycle => cycle.points.some(point => point.energy != null && Number.isFinite(point.energy)));
  return { available, label: available ? '可绘图' : '缺逐轮能量数据' };
}
export interface PostprocessPlotSnapshot {
  id: string; kind: 'scf' | 'levels'; title: string;
  source: TrajectoryResult['source']; resultId: string; jobIndex: number; frameIndex: number;
  scfCycles: NonNullable<TrajectoryResult['scientific']>['scfCycles'];
  orbitals: NonNullable<TrajectoryResult['scientific']>['orbitals'];
  decimals?:number;
}
/** Snapshot contains copied printed numbers and provenance, never readers or live source pointers. */
export function createPostprocessPlotSnapshot(result: TrajectoryResult, frameIndex: number, kind: PostprocessPlotSnapshot['kind'], id = `${result.id}:${frameIndex}:${kind}`): PostprocessPlotSnapshot {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= result.frames.length) throw new Error('图窗来源帧无效。');
  return structuredClone({ id, kind, title: kind === 'scf' ? 'SCF 收敛过程' : '二维轨道能级', source: result.source, resultId: result.id, jobIndex: result.jobIndex, frameIndex,
    scfCycles: result.scientific?.scfCycles.filter(cycle => cycle.frameIndex === frameIndex) ?? [], orbitals: result.scientific?.orbitals.filter(channel => channel.frameIndex === frameIndex) ?? [] });
}
export function postprocessPlotData(snapshot: PostprocessPlotSnapshot, unit: PostprocessEnergyUnit) {
  return { schema: 'sciyue-postprocess-plot.v1', source: snapshot.source, resultId: snapshot.resultId, jobIndex: snapshot.jobIndex, frameIndex: snapshot.frameIndex, kind: snapshot.kind, unit,
    cycles: snapshot.scfCycles.map(cycle => ({ ...cycle, points: cycle.points.map(point => ({ ...point, energy: point.energy == null ? null : convertEnergy({ value: point.energy, unit: 'hartree' }, unit), deltaEnergy: point.deltaEnergy == null ? null : convertEnergy({ value: point.deltaEnergy, unit: 'hartree' }, unit) })) })),
    channels: snapshot.orbitals.map(channel => ({ ...channel, originalUnit: channel.unit, unit, frontier: frontierOrbitals(channel, unit), orbitals: channel.orbitals.map(orbital => ({ ...orbital, energy: convertEnergy({ value: orbital.energy, unit: channel.unit }, unit) })) })) };
}
export function postprocessPlotText(snapshot: PostprocessPlotSnapshot, unit: PostprocessEnergyUnit): string {
  const data = postprocessPlotData(snapshot, unit);
  const rows = [`# ${snapshot.title}`, `# source=${snapshot.source.name}; source_id=${snapshot.source.id}; job=${snapshot.jobIndex + 1}; frame=${snapshot.frameIndex + 1}; unit=${postprocessUnitLabel(unit)}`];
  if (snapshot.kind === 'scf') {
    rows.push('cycle\tsource_line\titeration\tenergy\tdelta_energy');
    data.cycles.forEach((cycle, index) => cycle.points.forEach(point => rows.push([index + 1, cycle.sourceLine, point.iteration, point.energy ?? '', point.deltaEnergy ?? ''].join('\t'))));
  } else {
    rows.push('spin\tsource_line\torbital\tenergy\toccupation\tsource_name\tsource_id\tsource_index');
    data.channels.forEach(channel => channel.orbitals.forEach(orbital => rows.push([channel.spin, orbital.sourceLine ?? channel.sourceLine, orbital.index, formatResultValue(orbital.energy,snapshot.decimals??2), Number.isInteger(orbital.occupation)?String(orbital.occupation):formatResultValue(orbital.occupation,snapshot.decimals??2),
      orbital.sourceName ?? channel.sourceName ?? snapshot.source.name, orbital.sourceId ?? channel.sourceId ?? snapshot.source.id, orbital.sourceIndex ?? ''].join('\t'))));
  }
  return rows.join('\n') + '\n';
}
