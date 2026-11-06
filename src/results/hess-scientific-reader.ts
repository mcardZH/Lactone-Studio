import { atomicNumber } from '../core/elements';
import { BOHR_TO_ANGSTROM } from '../core/orca/assets';
import type { Structure } from '../core/types';
import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { streamSavedResultLines } from './fchk-scientific-reader';
import { emptyScientificData, scientificNumber, scientificRoundingInterval, type ScientificData } from './scientific-contracts';

interface Section { line: number; rows: { text: string; line: number }[]; comments: string[]; skipped?: boolean }
const wanted = new Set(['$atoms', '$vibrational_frequencies', '$normal_modes', '$ir_spectrum', '$raman_spectrum', '$act_energy', '$charge', '$multiplicity', '$actual_temperature', '$frequency_scale_factor', '$frequency_scale']);
const values = (text: string) => text.split(/\s+/).map(scientificNumber);

/** Parse the same column-block normal_modes layout used by core/orca/assets.ts. Never read $hessian. */
function normalModes(section: Section | undefined, dimension: number, notices: string[]): { matrix: Float64Array; rounding: number } | null {
  if (!section || section.skipped) return null;
  const rows = section.rows, declared = values(rows[0]?.text ?? '');
  if (declared.length !== 2 || declared.some(value => value !== dimension)) {
    notices.push('$normal_modes维数不符；未生成位移。'); return null;
  }
  let matrix: Float64Array, seen: Uint8Array;
  try { matrix = new Float64Array(dimension * dimension); seen = new Uint8Array(matrix.length); }
  catch (error) { notices.push(`$normal_modes实际资源分配失败；保留已读取频率和结构，位移未加载：${error instanceof Error ? error.message : String(error)}`); return null; }
  let columns: number[] = [], nextRow = dimension, count = 0, rounding = 0;
  for (const row of rows.slice(1)) {
    const tokens = row.text.split(/\s+/);
    if (nextRow === dimension) {
      if (!tokens.every(token => /^\d+$/.test(token))) { notices.push('$normal_modes列标题不合法；未生成位移。'); return null; }
      columns = tokens.map(Number);
      if (!columns.length || columns.length > 5 || columns.some(column => column >= dimension) || new Set(columns).size !== columns.length) {
        notices.push('$normal_modes列索引不合法；未生成位移。'); return null;
      }
      nextRow = 0; continue;
    }
    const rowIndex = scientificNumber(tokens[0]), numbers = tokens.slice(1).map(scientificNumber);
    if (rowIndex !== nextRow || numbers.length !== columns.length || numbers.some(value => value === null)) {
      notices.push('$normal_modes矩阵行不合法；未生成位移。'); return null;
    }
    for (let index = 0; index < columns.length; index++) {
      const offset = rowIndex! * dimension + columns[index];
      if (seen[offset]) { notices.push('$normal_modes重复矩阵元素；未生成位移。'); return null; }
      seen[offset] = 1; matrix[offset] = numbers[index]!; count++;
      rounding = Math.max(rounding, scientificRoundingInterval(tokens[index + 1]) ?? 0);
    }
    nextRow++;
  }
  if (count !== matrix.length) { notices.push('$normal_modes矩阵截断；未生成位移。'); return null; }
  return { matrix, rounding };
}

function scalar(sections: Map<string, Section>, key: string, notices: string[]): { value: number; sourceLine: number } | undefined {
  const section = sections.get(key); if (!section) return;
  const value = section.rows.length === 1 ? scientificNumber(section.rows[0].text) : null;
  const message=value===null?`HESS ${key} 标量无效。`:(key === '$charge' || key === '$multiplicity') && (!Number.isSafeInteger(value) || (key === '$multiplicity' && value < 1))?`HESS ${key}须为有效整数。`:/frequency_scale/.test(key) && value<=0?'HESS频率缩放因子须为正有限数。':undefined;
  if(message){const notice=`${message} 源行${section.line}；未采用该字段。`;if(!notices.includes(notice))notices.push(notice);return;}
  return { value: value!, sourceLine: section.rows[0].line };
}

function science(sections: Map<string, Section>, structure: Structure, notices: string[]): ScientificData {
  const data = emptyScientificData(); data.notices.push(...notices, 'HESS仅显示已保存字段；不证明完整作业历史、正常终止或驻点收敛。', 'Hessian矩阵已流式跳过，未对角化或重算频率/热化学。');
  sections.get('$atoms')!.rows.slice(1).forEach((row, index) => { const mass=scientificNumber(row.text.split(/\s+/)[1]);
    if(mass!==null&&mass>0)data.properties.push({ key: `atomic-mass:${index}`, label: `原子 ${index + 1} (${structure.atoms[index].element}) 已保存质量`,value:mass,unit:'amu',sourceLine:row.line,frameIndex:0 });
    else data.notices.push(`HESS原子${index+1}质量无效（源行${row.line}）；保留可靠坐标，未采用质量。`);
  });
  for (const [key, label, unit] of [['$act_energy', '已保存电子能量', 'hartree'], ['$actual_temperature', '已保存温度', 'K'], ['$charge', 'Charge', 'e'], ['$multiplicity', 'Multiplicity', '']] as const) {
    const field = scalar(sections, key, data.notices); if (!field) continue;
    const target = key === '$actual_temperature' ? data.thermochemistry : data.summary;
    target.push({ key, label, ...field, unit, frameIndex: 0 });
  }
  const frequency = sections.get('$vibrational_frequencies'), dim = structure.atoms.length * 3;
  if (!frequency) { data.notices.push('未保存$vibrational_frequencies；未从Hessian推导。'); return data; }
  const count = scientificNumber(frequency.rows[0]?.text ?? '');
  if (count !== dim || frequency.rows.length !== dim + 1) { data.notices.push('振动频率段截断或维数不符；未采用。'); return data; }
  if(frequency.rows.slice(1).some((row,index)=>{const numbers=values(row.text);return numbers.length!==2||numbers[0]!==index||numbers[1]===null;})) { data.notices.push(`HESS频率索引或数值无效（源行${frequency.line}）；未采用频率及模式位移。`); return data; }
  const frequencies = frequency.rows.slice(1).map((row, index) => {
    const numbers = values(row.text);
    return { frequency: numbers[1]!, frequencyRounding: scientificRoundingInterval(row.text.split(/\s+/)[1]), sourceLine: row.line, index };
  });
  const parsedModes = normalModes(sections.get('$normal_modes'), dim, data.notices), matrix = parsedModes?.matrix;
  if (!matrix) data.notices.push('缺少完整正常模式向量；保留频率但不生成位移。');
  const scale = scalar(sections, '$frequency_scale_factor', data.notices) ?? scalar(sections, '$frequency_scale', data.notices);
  data.tasks = ['freq'];
  data.vibrations = { frameIndex: 0, ...(scale ? { printedScaleFactor: scale.value } : {}),
    // ORCA 6.1 manual, Vibrational Spectroscopy, $normal_modes: Cartesian
    // displacements. Also checked against the paired development OUT/HESS: its
    // M(i,i)=1/sqrt(m[i]) transform is already applied; never apply it twice.
    convention: 'ORCA HESS频率cm⁻¹，保留源模式0起始编号及零频模式；正常模式为已转换的Cartesian位移，不再次按质量变换，显示振幅另行归一化。',
    modes: frequencies.map(mode => ({ ...mode, sourceIndex: mode.index, displacementConvention: 'cartesian', atomElements: structure.atoms.map(atom => atom.element),
      ...(matrix ? { displacementRounding: parsedModes!.rounding, displacements: structure.atoms.map((_, atom) => [matrix[(atom * 3) * dim + mode.index], matrix[(atom * 3 + 1) * dim + mode.index], matrix[(atom * 3 + 2) * dim + mode.index]] as [number, number, number]) } : {}),
    })) };
  for (const [key, label] of [['$ir_spectrum', 'IR'], ['$raman_spectrum', 'Raman activity']] as const) {
    const section = sections.get(key); if (!section || section.skipped) continue;
    const printedCount = scientificNumber(section.rows[0]?.text ?? '');
    if (printedCount !== dim || section.rows.length !== dim + 1) { data.notices.push(`${key}长度不符；未关联模式。`); continue; }
    const table = section.rows.slice(1).map(row => values(row.text));
    const headers = section.comments.map(comment => comment.replace(/^#\s*/, '').trim().toLowerCase().replace(/\s+/g, ' ')).filter(comment => /^wavenumber\b/.test(comment));
    const sixColumnIr = key === '$ir_spectrum' && headers.length === 1 && headers[0] === 'wavenumber eps int tx ty tz';
    const fiveColumnIr = key === '$ir_spectrum' && headers.length === 1 && /^wavenumber t(?:\*\*2|\^2|²) tx ty tz$/.test(headers[0]);
    const knownRaman = key === '$raman_spectrum' && headers.length === 1 && /^wavenumber activity depolarization$/.test(headers[0]);
    if (key === '$ir_spectrum' && !sixColumnIr && !fiveColumnIr) {
      data.notices.push('$ir_spectrum表头未确认；未猜测IR强度或T²单位。'); continue;
    }
    if (table.some((row, index) => row.length !== (key === '$ir_spectrum' ? sixColumnIr ? 6 : 5 : 3) || row.some(value => value === null) || Math.abs(row[0]! - frequencies[index].frequency) > 0.05 || row[1]! < 0 || sixColumnIr && row[2]! < 0)) {
      data.notices.push(`${key}布局或逐模式频率未确认；未借用强度。`); continue;
    }
    table.forEach((row, index) => {
      const sourceLine = section.rows[index + 1].line;
      if (sixColumnIr) {
        data.vibrations!.modes[index].irIntensity = row[2]!;
        data.vibrations!.modes[index].irIntensityUnit = 'km/mol';
        data.properties.push({ key: `${key}:eps:${index}`, label: `IR eps · 模式 ${index}`, value: row[1]!, unit: 'L/(mol·cm)', sourceLine, frameIndex: 0 });
      } else data.properties.push({ key: `${key}:${index}`, label: `${fiveColumnIr ? 'IR T²' : label} · 模式 ${index}`, value: row[1]!, unit: fiveColumnIr ? 'a.u.' : knownRaman ? 'Å⁴/amu' : '源原生单位（未确认）', sourceLine, frameIndex: 0 });
      if (key === '$raman_spectrum') {
        const mode = data.vibrations!.modes[index];
        mode.ramanActivity = row[1]!; mode.ramanActivitySourceLine = sourceLine;
        if (knownRaman) { mode.ramanActivityUnit = 'Å⁴/amu'; mode.ramanDepolarization = row[2]!; }
        // A saved HESS activity table alone cannot establish the response
        // frequency used for its polarizability derivatives.
        mode.ramanActivityConvention = 'unknown';
        if (section.comments.some(comment => /\bdynamic\b|frequency[- ]dependent|freq_[ri]/i.test(comment))) mode.ramanActivityConvention = 'dynamic';
        else if (section.comments.some(comment => /^#\s*(?:the\s+)?static raman spectrum\s*$/i.test(comment))) mode.ramanActivityConvention = 'static';
      }
      if (key === '$ir_spectrum') ['TX', 'TY', 'TZ'].forEach((axis, component) => data.properties.push({ key: `${key}:${axis}:${index}`, label: `IR ${axis} · 模式 ${index}`, value: row[(sixColumnIr ? 3 : 2) + component]!, unit: '源原生单位（未确认）', sourceLine, frameIndex: 0 }));
    });
    if (key === '$raman_spectrum') data.notices.push(knownRaman ? 'HESS Raman原始Activity及Å⁴/amu单位按明确表头保留；响应频率约定单独判断。' : 'HESS Raman原始Activity已保留；未确认单位，未标作Å⁴/amu。');
  }
  return data;
}

/** Read one saved ORCA HESS result, skipping Hessian and derivative matrices. */
export async function readHessScientificResult(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  let closed = false; const close = async () => { if (!closed) { closed = true; await file.close?.(); } };
  try {
    assertResultNotAborted(options.signal);
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error('HESS字节数须为正安全整数。');
    const sections = new Map<string, Section>(), notices: string[] = [];
    let active: Section | undefined, identity = false, lineNumber = 0, interruption: unknown;
    let pendingComments: string[] = [];
    try { for await (const raw of streamSavedResultLines(file, options)) {
      lineNumber++; const text = raw.trim().replace(/^\uFEFF/, '');
      if (!text) continue;
      if (text.startsWith('$')) {
        const key = text.toLowerCase(); if (key === '$orca_hessian_file') identity = true;
        if (wanted.has(key)) {
          if (sections.has(key)) {
            if(key==='$atoms')throw new Error(`HESS重复段 ${key}，不能静默选值。`);
            sections.set(key,{line:lineNumber,rows:[],comments:[],skipped:true});active=undefined;
            notices.push(`HESS重复段 ${key}（源行${lineNumber}）；未采用该歧义字段。`);pendingComments=[];continue;
          }
          active = { line: lineNumber, rows: [], comments: [...pendingComments] }; sections.set(key, active);
        } else active = undefined;
        pendingComments = [];
      } else if (active && !active.skipped) {
        if (text.startsWith('#')) active.comments.push(text);
        else active.rows.push({ text, line: lineNumber });
      }
      // ORCA prints a section's column header immediately before its $marker.
      // Keep that prefix separately from comments within the section.
      if (text.startsWith('#')) pendingComments.push(text);
      else if (!text.startsWith('$')) pendingComments = [];
    } } catch (error) { if (error instanceof Error && error.message.startsWith('HESS重复段')) throw error; interruption = error; }
    if (interruption) notices.push(options.signal?.aborted ? '读取已取消；保留此前完整有效的HESS字段与结构。' : `HESS读取停止；仅保留此前完整有效字段：${interruption instanceof Error ? interruption.message : String(interruption)}`);
    if (!identity) throw interruption ?? new Error('缺少$orca_hessian_file身份标识，未猜测格式。');
    const atomSection = sections.get('$atoms'), rows = atomSection?.rows ?? [], count = scientificNumber(rows[0]?.text ?? '');
    if (count === null || !Number.isSafeInteger(count) || count < 1 || rows.length !== count + 1) throw interruption ?? new Error('HESS $atoms原子段缺失、截断或数量无效。');
    const id = `${file.id}:hess:0`, atoms = rows.slice(1).map((row, index) => {
      const fields = row.text.split(/\s+/), numbers = fields.slice(1).map(scientificNumber);
      if (fields.length !== 5 || !atomicNumber(fields[0]) || numbers.slice(1).some(value => value === null)) throw new Error('HESS逐原子元素或Bohr坐标无效。');
      const position = numbers.slice(1).map(value => value! * BOHR_TO_ANGSTROM);
      if (!position.every(Number.isFinite)) throw new Error('HESS转换后的Å坐标非有限数。');
      return { element: fields[0], id: `${id}:atom:${index + 1}`, sourceIndex: index + 1, x: position[0], y: position[1], z: position[2] };
    });
    const initial: Structure = { id: `${id}:frame:0`, name: file.name, format: 'ORCA HESS', atoms, sourceAtomIds: atoms.map(atom => atom.id), dimension: 3,
      charge: scalar(sections, '$charge', notices)?.value ?? null, multiplicity: scalar(sections, '$multiplicity', notices)?.value ?? null,
      notes: [`来源 ${file.name}，job 1，源行 ${atomSection!.line}；$atoms坐标Bohr转为Å。`, '只读已保存几何；不继承收敛、末态频率或GBW可续算承诺。'] };
    const scientific = science(sections, initial, notices), energy = scalar(sections, '$act_energy', scientific.notices);
    if (scientific.vibrations) { scientific.vibrations.sourceId = file.id; scientific.vibrations.sourceName = file.name; }
    const coordinateRoundingAngstrom = rows.slice(1).reduce((largest,row) => row.text.split(/\s+/).slice(2).reduce((value,token)=>Math.max(value,(scientificRoundingInterval(token)??0)*BOHR_TO_ANGSTROM),largest),0);
    return [{ id, label: `${file.name} · ORCA HESS 已保存结果`, kind: 'calculation', engine: 'orca', jobIndex: 0, status: interruption ? 'incomplete' : 'unknown',
      source: { id: file.id, name: file.name, size: file.size }, messages: [...scientific.notices], scientific, initialStructure: structuredClone(initial),
      frames: [{ index: 0, sourceStep: null, time: null, energy: energy ? { value: energy.value, unit: 'hartree' } : null, convergence: [], sourceLine: atomSection!.line, coordinateRoundingAngstrom }],
      async getFrame(index, signal) { assertResultNotAborted(signal); if (closed) throw new Error('HESS结果已关闭。'); if (index !== 0) throw new Error('HESS只含一个已保存结构。'); return structuredClone(initial); }, dispose: close,
    }];
  } catch (error) { await close(); throw error; }
}
