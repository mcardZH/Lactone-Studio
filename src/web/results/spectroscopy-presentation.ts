import type { ExcitedState,OrbitalChannel } from '../../results/scientific-contracts';
import {frontierOrbitals} from '../../results/scientific-analysis';
import { EV_NM, effectiveMultiplicity, excitedStateWavelength, type ProjectedVibrationMode, type SpectrumProjection } from '../../results/spectroscopy';
import { formatResultValue } from '../../results/numeric-format';
import type { ScientificTableProjection } from './scientific-table';
import {isNativeEstimatedMultiplicity} from './scientific-presentation';

export function spectrumAxisRange(range: [number, number] | undefined, from: string, to: string): [number, number] | undefined {
  if (!range) return undefined;
  if (from === to) return range;
  if ((from === 'eV' && to === 'nm' || from === 'nm' && to === 'eV') && range[0] > 0) return [EV_NM / range[1], EV_NM / range[0]];
  return undefined;
}

export function excitedStateLabel(state: ExcitedState, unrestricted = false): string {
  if (unrestricted||isNativeEstimatedMultiplicity(state)) return `State ${state.index}`;
  return /^(singlet|1)$/i.test(state.multiplicity?.trim() ?? '') ? `S${state.index}`
    : /^(triplet|3)$/i.test(state.multiplicity?.trim() ?? '') ? `T${state.index}` : `State ${state.index}`;
}
export function excitedStateTable(states: readonly ExcitedState[], unrestricted = false, decimals = 2): ScientificTableProjection {
  const number = (value: number | null | undefined) => formatResultValue(value, decimals);
  return { columns: [{ key: 'state', label: '态' }, { key: 'energy', label: 'ΔE / eV', heading:'ΔE',headerUnit:'eV' }, { key: 'wavelength', label: 'λ / nm',heading:'λ',headerUnit:'nm' },
    { key: 'f', label: 'f' }],
  rows: states.map((state, index) => ({ key: String(index), cells: [excitedStateLabel(state, unrestricted), number(state.energyEv), number(excitedStateWavelength(state)?.value), number(state.oscillatorStrength)] })) };
}
/** Spin diagnostics stay available without expanding the four-column main table. */
export function excitedStateDetails(state: ExcitedState, decimals = 2): string[] {
  const details = [`态来源行 ${state.sourceLine}`];
  const wavelength = excitedStateWavelength(state);
  if (wavelength?.source === 'energy') details.push('λ由激发能换算：λ / nm = 1239.8419843320026 / (ΔE / eV)');
  if (state.spinSquared != null) details.push(`⟨S²⟩ = ${formatResultValue(state.spinSquared, decimals)}`);
  const multiplicity = effectiveMultiplicity(state.spinSquared);
  if (multiplicity != null) details.push(`重态数 = ${formatResultValue(multiplicity, decimals)}*`);
  if (state.multiplicity) details.push(`原生重态数：${state.multiplicity}${isNativeEstimatedMultiplicity(state) ? '（估计）' : ''}`);
  return details;
}
export function transitionTable(state: ExcitedState, decimals = 2,context?:{engine:string;reference?:string;channels:readonly OrbitalChannel[]}): ScientificTableProjection {
  const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : formatResultValue(value, decimals);
  const gaussianContribution=context?.engine==='gaussian'&&context.reference==='restricted'&&context.channels.length>0&&context.channels.every(channel=>channel.spin==='restricted'&&channel.orbitals.length&&channel.orbitals.every(orbital=>orbital.occupation===0||orbital.occupation===2));
  const orbitalLabel=(raw:string,spin?:'alpha'|'beta'|'mixed')=>{
    const match=raw.match(/^(\d+)([ab]?)$/i);if(!context||!match)return raw;
    const selectedSpin=match[2]?match[2].toLowerCase()==='a'?'alpha':'beta':spin;
    if(selectedSpin==='mixed')return raw;
    const channel=context.channels.find(row=>row.spin===(selectedSpin==='alpha'||selectedSpin==='beta'?selectedSpin:'restricted'));
    if(!channel)return raw;const frontier=frontierOrbitals(channel,'hartree'),index=Number(match[1]),orbital=channel.orbitals.find(row=>row.index===index);
    if(!orbital)return raw;
    const anchor=orbital.occupation>1e-8?frontier.homo:frontier.lumo;if(!anchor)return raw;
    const delta=index-anchor.index,label=orbital.occupation>1e-8?'HOMO':'LUMO';
    return `${label}${delta?delta<0?'−'+Math.abs(delta):'+'+delta:''}（MO ${raw}）`;
  };
  return { columns: [{ key: 'from', label: '初始轨道' }, { key: 'to', label: '目标轨道' }, { key: 'spin', label: '自旋' },
    { key: 'amplitude', label: '组态系数' }, { key: 'contribution', label: '贡献 / %', heading: '贡献', headerUnit: '%' }],
  rows: state.transitions.map((row, index) => {
    // ORCA prints native weights. Gaussian closed-shell c uses 2c², only for
    // verified forward excitations; neither route renormalizes a truncated list.
    const contribution = row.weight != null ? 100 * row.weight : gaussianContribution && !row.spin && row.direction === '->' && row.amplitude != null ? 200 * row.amplitude ** 2 : null;
    return { key: String(index), cells: [orbitalLabel(row.from,row.spin), orbitalLabel(row.to,row.spin), row.spin === 'alpha' ? 'α' : row.spin === 'beta' ? 'β' : row.spin === 'mixed' || context?.reference === 'restricted' ? 'α/β' : '—', number(row.amplitude), number(contribution)] };
  }) };
}
export function vibrationModeTable(modes: readonly ProjectedVibrationMode[], scaled: boolean, decimals = 2): ScientificTableProjection {
  const number = (value: number | null | undefined) => formatResultValue(value, decimals);
  const units = [...new Set(modes.filter(mode => mode.irIntensity != null).map(mode => mode.irIntensityUnit ?? '单位未确认'))];
  const unit = units.length === 1 && units[0] !== '单位未确认' ? units[0] : null;
  const ramanModes=modes.filter(mode=>mode.ramanActivity!=null&&Number.isFinite(mode.ramanActivity));
  const ramanUnits=[...new Set(ramanModes.map(mode=>mode.ramanActivityUnit??'单位未确认'))],ramanUnit=ramanUnits.length===1&&ramanUnits[0]!=='单位未确认'?ramanUnits[0]:null;
  return { columns: [{ key: 'mode', label: '模式' }, { key: 'frequency', label: '原频率 / cm⁻¹',heading:'原频率',headerUnit:'cm⁻¹' },
    ...(scaled ? [{ key: 'scaled', label: '校正频率 / cm⁻¹',heading:'校正频率',headerUnit:'cm⁻¹' }] : []), { key: 'intensity', label: unit ? `IR / ${unit}` : 'IR / 来源单位',heading:'IR',...(unit?{headerUnit:unit}:{}) },...(!unit?[{key:'intensity-unit',label:'IR单位'}]:[]),...(ramanModes.length?[{key:'raman-activity',label:ramanUnit?`拉曼活性 / ${ramanUnit}`:'拉曼活性 / 来源单位',heading:'拉曼活性',...(ramanUnit?{headerUnit:ramanUnit}:{})},...(!ramanUnit?[{key:'raman-unit',label:'拉曼活性单位'}]:[])]:[])],
  rows: modes.map(mode => ({ key: String(mode.displayIndex), cells: [String(mode.displayIndex), number(mode.originalFrequency),
    ...(scaled ? [number(mode.correctedFrequency)] : []), number(mode.irIntensity),...(!unit?[mode.irIntensity==null?'未输出':mode.irIntensityUnit??'单位未确认']:[]),...(ramanModes.length?[number(mode.ramanActivity),...(!ramanUnit?[mode.ramanActivity==null?'未输出':mode.ramanActivityUnit??'单位未确认']:[])]:[])] })) };
}
export function spectrumText(spectrum: SpectrumProjection, sticks: boolean, decimals = 2): string {
  const number = (value: number | null | undefined) => formatResultValue(value, decimals);
  return [`${spectrum.xUnit}\t${sticks ? spectrum.stickIntensityUnit : spectrum.intensityUnit}`,
    ...(sticks ? spectrum.sticks : spectrum.points).map(point => `${number(point.x)}\t${number(point.y)}`)].join('\n') + '\n';
}
