import { FchkReader, fchkHeaderFields, fchkNumber } from '../core/fchk-reader';
import { BASES, METHODS, canonicalBasis } from '../core/catalog';
import { expectedModeCount } from '../core/gaussian-vibronic/source';
import { gaussianRouteTokens } from '../core/gaussian-source';
import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { emptyScientificData, type ScientificData } from './scientific-contracts';
import { gaussianScientificTasks } from './gaussian-scientific-parser';
import { fchkCharacterRecord,streamFchkRecords } from '../core/fchk-records';

interface Field { values: number[]; sourceLine: number;rawValue?:string }
const arrays = new Set(['Nuclear charges', 'Shell types', 'Alpha Orbital Energies', 'Beta Orbital Energies', 'Alpha Orbital Occupation Numbers', 'Beta Orbital Occupation Numbers',
  'Mulliken Charges', 'ESP Charges', 'NPA Charges', 'Real atomic weights', 'Dipole Moment', 'Quadrupole Moment', 'Vib-E2', 'Vib-Modes']);
const scalars = new Set(['Charge', 'Multiplicity', 'Number of alpha electrons', 'Number of beta electrons', 'Number of electrons',
  'Number of Normal Modes', 'Number of basis functions', 'Number of contracted shells', 'Number of primitive shells', 'Highest angular momentum',
  'Pure/Cartesian d shells', 'Pure/Cartesian f shells', 'Number of independent functions', 'Number of independant functions',
  'SCF Energy', 'Total Energy', 'MP2 Energy', 'Job Status', 'Virial Ratio', 'RMS Density']);
const characters = new Set(['Gaussian Version', 'Route']);
const fieldPattern = /^(.+?)\s+([IRCLH])\s+(?:N=\s*(\d+)\s*|(\S+)\s*)$/;

/** Stream only individual lines, even when coefficients occupy most of a multi-GB file. */
export async function* streamSavedResultLines(file: ResultInputFile, options: ResultReadOptions): AsyncGenerator<string> {
  for await(const record of streamFchkRecords(file,{...options,fchk:false}))yield record.text;
}

class SavedFields {
  readonly numeric = new Map<string, Field>();
  readonly characters = new Map<string, { value: string; sourceLine: number }>();
  readonly notices: string[] = [];
  incomplete = false;
  header = '';
  geometryLine = 1;
  private number = 0;
  private fieldCount = 0;
  private retained = 0;
  private invalid = new Set<string>();
  private seen = new Set<string>();
  private active: { label: string; type: string; remaining: number; capture: boolean; values: number[]; text: string; sourceLine: number } | null = null;
  consume(raw: string,context?:{sourceLine:number;byteProven?:boolean}): void {
    this.number=context?.sourceLine??this.number+1;
    if(this.active&&(this.active.type==='C'||this.active.type==='H')&&this.active.remaining){
      const part=fchkCharacterRecord(raw,this.active.type,this.active.remaining,context?.byteProven);
      if(this.active.capture)this.active.text+=part.text;this.active.remaining-=part.count;if(!this.active.remaining)this.complete();return;
    }
    if (this.number === 2) this.header = raw;
    if (this.number < 3) return;
    const match = raw.match(fieldPattern);
    if (match) {
      if (this.active?.remaining) this.truncated();
      this.fieldCount++;
      const label = match[1].trim(), type = match[2], wanted = arrays.has(label) || scalars.has(label) || characters.has(label)
        || ['Atomic numbers', 'Number of atoms', 'Current cartesian coordinates', 'Route', 'Full Title'].includes(label);
      if (label === 'Current cartesian coordinates') this.geometryLine = this.number;
      if (this.seen.has(label) && wanted) {
        if (['Atomic numbers','Number of atoms','Current cartesian coordinates'].includes(label)) throw new Error(`FCHK科学字段 ${label} 重复，不能静默选值。`);
        this.incomplete=true; this.invalid.add(label); this.numeric.delete(label); this.characters.delete(label);
        this.notices.push(`FCHK ${label} 重复；未采用该歧义字段（源行${this.number}）。`);
      }
      this.seen.add(label);
      if (match[3] !== undefined) {
        const count = Number(match[3]);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('FCHK数组长度声明无效。');
        const capture = characters.has(label) && ['C', 'H'].includes(type) || arrays.has(label) && ['I', 'R'].includes(type);
        if (arrays.has(label) && !capture) this.notices.push(`${label}字段类型不属于已支持的科学读取格式；未保留该字段。`);
        if(arrays.has(label)&&!['I','R'].includes(type))this.incomplete=true;
        if (capture) this.retained += count;
        this.active = { label, type, remaining: count, capture, values: [], text: '', sourceLine: this.number };
        if (count === 0) this.complete();
      } else {
        this.active = null;
        if (scalars.has(label)) {
          const value = fchkNumber(match[4]);
          if (!['I', 'R'].includes(type) || value === null || ((type === 'I'||['Charge','Multiplicity'].includes(label)) && !Number.isSafeInteger(value)) || label==='Multiplicity'&&value<1) { this.incomplete=true; this.notices.push(`FCHK科学标量 ${label} 无效（源行${this.number}）；未采用。`); return; }
          if (!this.invalid.has(label)) this.numeric.set(label, { values: [value], sourceLine: this.number,...(/^(?:SCF|Total|MP2) Energy$/.test(label)?{rawValue:match[4]}:{}) });
        }
      }
      return;
    }
    const active = this.active;
    if (!active) return;
    {
      const parts = raw.trim().split(/\s+/).filter(Boolean);
      if (parts.length > active.remaining) {
        this.incomplete=true;this.notices.push(`FCHK ${active.label} 超过声明长度；未使用该损坏字段。`);this.active=null;return;
      }
      active.remaining -= parts.length;
      if (active.capture) for (const part of parts) {
        const value = fchkNumber(part);
        if (value === null || (active.type === 'I' && !Number.isSafeInteger(value))) { this.incomplete=true;this.notices.push(`FCHK ${active.label} 包含无效数值（源行${this.number}）；未采用该字段。`); this.active=null; return; }
        active.values.push(value);
      }
    }
    if (!active.remaining) this.complete();
  }
  private truncated(): void {
    this.incomplete=true;this.notices.push(`FCHK ${this.active!.label} 数组截断；未使用该不完整字段。`); this.active = null;
  }
  private complete(): void {
    const active = this.active!;
    if (active.capture && !this.invalid.has(active.label)) {
      if (['C', 'H'].includes(active.type)) this.characters.set(active.label, { value: active.text.trim(), sourceLine: active.sourceLine });
      else this.numeric.set(active.label, { values: active.values, sourceLine: active.sourceLine });
    }
    this.active = null;
  }
  finish(): void { if (this.active?.remaining) this.truncated(); }
}

/** Route/echo facts only: no editable-input defaults are promoted to scientific observations. */
export function appendGaussianRouteSummary(data: ScientificData, route: string, sourceLine: number, origin: string, frameIndex: number | null = null): void {
  const put = (key: string, label: string, value: string) => data.summary.push({ key, label: `${label} (${origin})`, value, sourceLine, frameIndex });
  const verbosity = route.match(/^\s*#([pnt])(?=\s|$)/i)?.[1];
  if (verbosity) put('output-verbosity', '输出级别', `#${verbosity.toUpperCase()}`);
  for (const token of gaussianRouteTokens(route)) {
    const key = token.match(/^([a-z][\w-]*)/i)?.[1].toLowerCase() ?? '', argument = token.replace(/^[^=(]+\s*=?\s*/, '').replace(/^\((.*)\)$/, '$1');
    if (/^[a-z][\w-]*(?:\([^)]*\))?\//i.test(token) && !['iop', 'external'].includes(key)) {
      const slash = token.indexOf('/'); put('method', '方法', token.slice(0, slash)); put('basis', '基组', token.slice(slash + 1));
      const reference = token.slice(0, slash).match(/^(RO)(?=HF)|^([RU])(?=[A-Za-z])/i)?.[0];
      if (reference) put('reference-state', '参考态', reference.toUpperCase());
    }
    if (!token.includes('/') && METHODS.some(method => method.keyword.toLowerCase() === token.toLowerCase())) put('method', '方法', token);
    if (!token.includes('/') && (BASES.some(basis => basis.value === canonicalBasis(token)) || /^(?:gen|genecp)$/i.test(token))) put('basis', '基组', token);
    if (/^(?:em|empiricaldispersion)$/.test(key)) put('dispersion', '色散', argument);
    if (/^(?:int|integral)$/.test(key)) put('integration-grid', '积分设置', token);
    if (key === 'scf') put('scf-settings', 'SCF设置', token);
    if (key === 'opt') put('optimization-settings', '优化设置', token);
    if (key === 'pseudo' || /genecp/i.test(token)) put('ecp', 'ECP设置', token);
    if (/^(?:dkh|dk|x2c|zora)$/.test(key)) put('relativistic', '相对论设置', token);
    if (/^(?:densityfit|ri|rij|rijk|autoaux)$/.test(key)) put('ri', 'RI/拟合设置', token);
    if (/^(?:5d|6d|7f|10f)$/i.test(token)) put('basis-shells', '基组壳类型', token.toUpperCase());
    if (key === 'scrf') {
      const model = argument.match(/\b(SMD|IEFPCM|CPCM|PCM|IPCM|SCIPCM|Onsager|Dipole)\b/i)?.[1];
      if (model) put('solvent-model', '溶剂模型', model.toUpperCase());
      const solvent = argument.match(/\bsolvent\s*=\s*([^,)\s]+)/i)?.[1];
      if (solvent) put('solvent', '溶剂', solvent);
      put('solvent-settings', '溶剂设置', token);
    }
  }
}

/** A saved SCF reference is only the target energy for an identified HF/DFT method. */
function frameEnergy(saved: SavedFields, structure: TrajectoryResult['initialStructure'], data: ScientificData): { field: Field; label: string } | null {
  const total = saved.numeric.get('Total Energy');
  if (total) return { field: total, label: '已保存能量：Total Energy' };
  const tokens = gaussianRouteTokens(structure.sourceRoute ?? '').map(token => token.toLowerCase());
  const keys = tokens.map(token => token.split(/[=(\/]/)[0]);
  const blocked = keys.some(key => /^(?:td|tda|cis|zindo|oniom|external|casscf|caspt2|ccsd|cisd|qcisd|mp[345]|b2plyp|doublehybrid|eom|nevpt2)$/.test(key) || /^(?:dsd-|dlpno)/.test(key));
  let label: string | null = null;
  if (!blocked && keys.some(key => /^[ru]?mp2$/.test(key))) label = 'MP2 Energy';
  else if (!blocked && keys.some(key => /^(?:[ru]?hf|rohf|[ru]?(?:b3lyp|b3pw91|blyp|bp86|pbe0|pbe1pbe|pbepbe|pbe|m062x|m06-2x|m06|m06l|m06-l|m052x|m05-2x|tpss|tpsstpss|tpssh|camb3lyp|cam-b3lyp|wb97xd|wb97x-d|wb97x|wb97m-v|b97d|b97-d|r2scan|scan|svwn|lsda))$/.test(key))) label = 'SCF Energy';
  // Conflicting FCHK header/Route cannot establish which saved reference is the target.
  if (structure.gaussianSource?.issues.some(issue => issue.code === 'fchk-header-route-conflict')) label = null;
  const field = label ? saved.numeric.get(label) : undefined;
  if (field) return { field, label: `已保存能量：${label}` };
  data.notices.push(label ? `来源方法目标为${label}，但未保存此字段或Total Energy；帧能量保持空缺。`
    : '缺少Total Energy且未可靠识别目标方法/电子态能量；帧能量保持空缺，SCF仅保留为来源摘要。');
  return null;
}

function savedScience(saved: SavedFields, structure: TrajectoryResult['initialStructure']): ScientificData {
  const data = emptyScientificData(), fields = saved.numeric, scalar = (label: string) => fields.get(label)?.values[0];
  data.route = structure.sourceRoute ?? ''; data.tasks = gaussianScientificTasks(data.route, false);
  const header = fchkHeaderFields(saved.header), savedRoute = saved.characters.get('Route');
  const put = (key: string, label: string, value: string | number, sourceLine: number, unit?: string,rawValue?:string) => data.summary.push({ key, label, value, sourceLine, frameIndex: 0, ...(unit ? { unit } : {}),...(rawValue===undefined?{}:{rawValue}) });
  if (!data.tasks.length) {
    const tasks = { sp: 'sp', fopt: 'opt', opt: 'opt', freq: 'freq', irc: 'irc', scan: 'scan' } as const;
    const task = tasks[header.task.toLowerCase() as keyof typeof tasks];
    if (task) data.tasks.push(task);
  }
  if (header.method) put('method', '方法 (FCHK header)', header.method, 2);
  if (header.basis) put('basis', '基组 (FCHK header)', header.basis, 2);
  const reference = header.method.match(/^(RO)(?=HF)|^([RU])(?=[A-Za-z])/i)?.[0];
  if (reference) put('reference-state', '参考态 (FCHK header)', reference.toUpperCase(), 2);
  if (savedRoute) appendGaussianRouteSummary(data, savedRoute.value, savedRoute.sourceLine, 'saved Route', 0);
  const version = saved.characters.get('Gaussian Version');
  if (version) { data.version = version.value; put('software-version', '软件版本 (FCHK saved)', version.value, version.sourceLine); }
  data.notices.push(...saved.notices, 'FCHK仅表示已保存字段与当前几何；不代表完整作业历史、优化收敛或正常终止。', '未读取MO系数或从Hessian重算频率、热化学。');
  data.notices.push(...(structure.gaussianSource?.issues.map(issue => issue.message) ?? []));
  for (const label of scalars) {
    const field = fields.get(label); if (!field) continue;
    put(label, `${label} (FCHK saved)`, field.values[0], field.sourceLine, /Energy/.test(label) ? 'hartree' : undefined,field.rawValue);
  }
  const shells = fields.get('Shell types');
  if (shells) {
    const names = new Map<number, string>([[0, 'S'], [1, 'P'], [-1, 'SP'], [2, '6D'], [-2, '5D'], [3, '10F'], [-3, '7F']]);
    const types = [...new Set(shells.values)];
    if (types.every(value => Number.isSafeInteger(value))) put('basis-shells', '壳类型 (FCHK Shell types)', types.map(value => names.get(value) ?? `L=${value} (saved code)`).join(', '), shells.sourceLine);
  }
  const nuclear = fields.get('Nuclear charges');
  if (nuclear && nuclear.values.length === structure.atoms.length) {
    nuclear.values.forEach((value, atomIndex) => data.properties.push({ key: `nuclear-charge:${atomIndex}`, label: `原子 ${atomIndex + 1} 有效核电荷 (FCHK saved)`, value, unit: 'e', sourceLine: nuclear.sourceLine, frameIndex: 0 }));
    // The geometry reader has already compared nuclear and atomic charges; this
    // detects effective cores without guessing their named potential or basis.
    if (structure.gaussianSource?.issues.some(issue => issue.code === 'fchk-ecp')) put('ecp', 'ECP (FCHK saved nuclear charges)', '有效核电荷与原子序数不同；势函数名称/参数未保存', nuclear.sourceLine);
  }
  const alpha = fields.get('Alpha Orbital Energies'), beta = fields.get('Beta Orbital Energies');
  const alphaN = scalar('Number of alpha electrons'), betaN = scalar('Number of beta electrons');
  for (const [name, channel, electrons] of [['Alpha', alpha, alphaN], ['Beta', beta, betaN]] as const) {
    if (!channel) continue;
    const explicit = fields.get(`${name} Orbital Occupation Numbers`);
    const restricted = name === 'Alpha' && !beta;
    const count = channel.values.length, declared = scalar('Number of independent functions') ?? scalar('Number of independant functions');
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared !== count)) {
      data.notices.push(`${name}轨道能量长度与独立函数数不符；未采用该通道。`); continue;
    }
    const validN = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= count;
    let occupations: number[];
    if (explicit && explicit.values.length === count && explicit.values.every(value => value >= 0 && value <= (restricted ? 2 : 1))) occupations = explicit.values;
    else if (explicit) { data.notices.push(`${name}轨道占据数组无效；未采用该通道。`); continue; }
    else if (validN(electrons) && (!restricted || validN(betaN))) occupations = channel.values.map((_, index) => (index < electrons! ? 1 : 0) + (restricted && index < betaN! ? 1 : 0));
    else { data.notices.push(`${name}轨道能量存在但没有可靠占据数；未补零占据或猜HOMO。`); continue; }
    data.orbitals.push({ spin: restricted ? 'restricted' : name.toLowerCase() as 'alpha' | 'beta', frameIndex: 0, sourceLine: channel.sourceLine,
      unit: 'hartree', orbitals: channel.values.map((energy, index) => ({ index: index + 1, energy, occupation: occupations[index] })) });
  }
  for (const [label, scheme] of [['Mulliken Charges', 'Mulliken'], ['ESP Charges', 'ESP'], ['NPA Charges', 'NPA']]) {
    const field = fields.get(label); if (!field) continue;
    if (field.values.length !== structure.atoms.length) { data.notices.push(`${label}原子数不符；未采用该表。`); continue; }
    data.atomicProperties.push({ kind: 'charge', scheme, frameIndex: 0, sourceLine: field.sourceLine, unit: 'e',
      values: field.values.map((value, atomIndex) => ({ atomIndex, element: structure.atoms[atomIndex].element, value })) });
  }
  const masses = fields.get('Real atomic weights');
  if (masses && masses.values.length === structure.atoms.length && masses.values.every(value => value > 0)) {
    masses.values.forEach((value, index) => data.properties.push({ key: `atomic-mass:${index}`, label: `原子 ${index + 1} (${structure.atoms[index].element}) 已保存质量`, value, unit: 'amu', sourceLine: masses.sourceLine, frameIndex: 0 }));
  } else if (masses) data.notices.push('已保存逐原子质量长度或数值无效；未采用。');
  for (const [label, components, unit] of [['Dipole Moment', ['X', 'Y', 'Z'], 'e·bohr'], ['Quadrupole Moment', ['XX', 'YY', 'ZZ', 'XY', 'XZ', 'YZ'], 'e·bohr²']] as const) {
    const field = fields.get(label); if (!field) continue;
    if (field.values.length !== components.length) { data.notices.push(`${label}分量长度不符；未采用。`); continue; }
    field.values.forEach((value, index) => data.properties.push({ key: `${label}:${components[index]}`, label: `${label} ${components[index]}`, value, unit, sourceLine: field.sourceLine, frameIndex: 0 }));
  }
  const e2 = fields.get('Vib-E2'), vectors = fields.get('Vib-Modes'), declaredModes = scalar('Number of Normal Modes');
  if (e2) {
    const count = declaredModes ?? expectedModeCount(structure.atoms);
    if (!Number.isSafeInteger(count) || count < 1 || count > 3 * structure.atoms.length || e2.values.length < count || e2.values.length % count !== 0) data.notices.push('Vib-E2模式数或分段长度不可靠；未采用频率。');
    else {
      if (declaredModes === undefined) data.notices.push('FCHK未保存Number of Normal Modes；仅按现有几何的全分子模式数核对Vib-E2/Vib-Modes，不能确认部分Hessian或冻结来源。');
      const complete = vectors?.values.length === count * 3 * structure.atoms.length;
      if (!complete) data.notices.push('缺少完整Vib-Modes数组；频率可查看，未生成位移。');
      // Standard saved order: frequency, reduced mass, force constant, IR, Raman.
      // Reference: cclib/parser/fchkparser.py; never diagonalize saved force constants.
      const raman=e2.values.length>=5*count?e2.values.slice(4*count,5*count):null;
      // Vib-E2 reserves Raman slots even without a Raman response. A requested
      // route, NDFDPol count or derivative-array shape alone does not prove that
      // an all-zero response completed. Keep that case unknown; within an
      // evidenced nonzero block, native zero modes are genuine values.
      const ramanEvidence=!!raman&&raman.some(value=>value>0);
      if(raman&&raman.every(value=>value===0)&&!ramanEvidence)data.notices.push('Vib-E2零值拉曼区段缺少已计算证据；拉曼可用性未确认，原文件保留。');
      data.vibrations = { frameIndex: 0, convention: 'FCHK Vib-E2: cm⁻¹；Vib-Modes为Cartesian位移，按mode/atom/xyz原样保存，不再次按质量变换，显示振幅另行归一化。',
        modes: Array.from({ length: count }, (_, index) => ({ index: index + 1, sourceIndex: index + 1,
          // Gaussian vib.pdf §2.6 defines normalized Cartesian displacements.
          // Paired development H2O/NH3 FCHK Vib-Modes agree directly with the
          // printed OUT vectors (within its 0.01 precision), without mass transforms.
          displacementConvention: 'cartesian', frequency: e2.values[index], sourceLine: e2.sourceLine,
          atomElements: structure.atoms.map(atom => atom.element),
          ...(e2.values.length >= 2 * count && e2.values[count + index] > 0 ? { reducedMass: e2.values[count + index] } : {}),
          ...(e2.values.length >= 4 * count && e2.values[3 * count + index] >= 0 ? { irIntensity: e2.values[3 * count + index], irIntensityUnit: 'km/mol' } : {}),
          ...(ramanEvidence && e2.values[4 * count + index] >= 0 ? { ramanActivity: e2.values[4 * count + index], ramanActivityUnit: 'Å⁴/amu', ramanActivitySourceLine: e2.sourceLine,
            ramanActivityConvention: savedRoute?.value ? /\bcphf\s*(?:=|\()[^#]*\brdfreq\b|\broa\b/i.test(savedRoute.value) ? 'dynamic' as const : 'static' as const : 'unknown' as const } : {}),
          ...(complete ? { displacements: Array.from({ length: structure.atoms.length }, (_, atom) => vectors!.values.slice((index * structure.atoms.length + atom) * 3, (index * structure.atoms.length + atom) * 3 + 3) as [number, number, number]) } : {}),
        })) };
    }
  } else if (vectors) data.notices.push('Vib-Modes存在但缺少可靠频率字段；未构造模式。');
  data.notices.push('此读取器尚无可靠映射的FCHK热化学字段；热化学保持空缺。');
  return data;
}

/** One read-only saved calculation, not an invented optimization trajectory or binary CHK conversion. */
export async function readFchkScientificResult(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await file.close?.(); } };
  try {
    assertResultNotAborted(options.signal);
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error('FCHK字节数须为正安全整数。');
    const geometry = new FchkReader(), saved = new SavedFields();
    let interruption: unknown, consuming = false;
    try { for await (const record of streamFchkRecords(file,options)) { consuming = true; const context={sourceLine:record.sourceLine,byteProven:true};saved.consume(record.text,context);geometry.consume(record.text,context); consuming = false; } }
    catch (error) { if (consuming && !(error instanceof RangeError)) throw error; interruption = error; }
    saved.finish();
    const initial = (() => { try { return geometry.finish(file.name)[0]; } catch (error) { throw interruption ?? error; } })(), id = `${file.id}:fchk:0`;
    if (initial.charge !== null && !Number.isSafeInteger(initial.charge)) throw new Error('FCHK电荷须为整数。');
    if (initial.multiplicity !== null && (!Number.isSafeInteger(initial.multiplicity) || initial.multiplicity < 1)) throw new Error('FCHK多重度须为正整数。');
    initial.id = `${id}:frame:0`;
    initial.atoms.forEach((atom, index) => { atom.id = `${id}:atom:${index + 1}`; atom.sourceIndex = index + 1; });
    initial.sourceAtomIds = initial.atoms.map(atom => atom.id!);
    initial.notes.push(`来源 ${file.name}，job 1，源行 ${saved.geometryLine}；仅保存的当前几何。`);
    const scientific = savedScience(saved, initial), energy = frameEnergy(saved, initial, scientific);
    const incomplete=geometry.incomplete||saved.incomplete||!!interruption;
    if (interruption) scientific.notices.push(options.signal?.aborted ? '读取已取消；保留此前完整有效的保存结构与科学字段。' : `来源读取停止；仅保留此前完整有效字段：${interruption instanceof Error ? interruption.message : String(interruption)}`);
    if (incomplete) scientific.notices.push('来源含损坏或截断的未使用字段；仅展示可靠完整的保存结构和已读数值，未确认完整波函数可用于派生计算。');
    const result: TrajectoryResult = {
      id, label: `${file.name} · FCHK 已保存结果`, kind: 'calculation', engine: 'gaussian', jobIndex: 0, status: incomplete ? 'incomplete' : 'unknown',
      source: { id: file.id, name: file.name, size: file.size }, messages: [...scientific.notices], scientific,
      initialStructure: structuredClone(initial), frames: [{ index: 0, sourceStep: null, time: null, energy: energy ? { value: energy.field.values[0], unit: 'hartree' } : null, ...(energy ? { label: energy.label } : {}), convergence: [], sourceLine: saved.geometryLine }],
      async getFrame(index, signal) { assertResultNotAborted(signal); if (closed) throw new Error('FCHK结果已关闭。'); if (index !== 0) throw new Error('FCHK只含一个已保存结构。'); return structuredClone(initial); },
      dispose: close,
    };
    return [result];
  } catch (error) { await close(); throw error; }
}
