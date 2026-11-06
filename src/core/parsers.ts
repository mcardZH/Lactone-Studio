import type { Atom, Structure } from './types';
import { assertNoMol2Source, parsePeriodicStructures } from './periodic-parsers';
import { elementSymbol } from './elements';
import { parseOrcaInput } from './orca-readers';
import { parseQuantumOutput } from './gaussian-reader';
import { recognizeSourceText } from '../results/source-recognition';
import { applyGaussianLink0, applyGaussianTail, parseGaussianSource } from './gaussian-source';
import { FchkReader } from './fchk-reader';
import { fchkTextRecords, looksLikeFchk } from './fchk-records';
import { cellInverse, cross3, norm3 } from './periodic';
import type { Vector3 } from './types';

const BOHR_TO_ANGSTROM = 0.529177210903;


function numberValue(raw: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(raw.trim())) throw new Error(`坐标“${raw}”不是有效数字。`);
  const value = Number(raw.replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) throw new Error('坐标必须为有限数值。');
  return value;
}

function atom(element: string, x: string, y: string, z: string, scale = 1): Atom {
  const result = { element: elementSymbol(element), x: numberValue(x) * scale, y: numberValue(y) * scale, z: numberValue(z) * scale };
  if (![result.x, result.y, result.z].every(Number.isFinite)) throw new Error('单位转换后的坐标不是有限数值。');
  return result;
}

function checkCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('原子数须为正安全整数。');
}

function base(name: string, format: string, index = 0): Structure {
  return { id: `${name}-${index}`, name, format, atoms: [], charge: null, multiplicity: null, notes: [] };
}

function parseXyz(text: string, name: string): Structure[] {
  const lines = text.split('\n');
  const structures: Structure[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    if (!/^\d+$/.test(lines[i].trim())) throw new Error(`XYZ第${i + 1}行应为原子数，未忽略任何尾部内容。`);
    const n = Number(lines[i++]); checkCount(n);
    if (i >= lines.length) throw new Error('XYZ缺少注释行。');
    const comment = lines[i++];
    let speciesColumn = 0; let positionColumn = 1; let totalColumns = 0;
    const properties = comment.match(/\bProperties\s*=\s*"?([^"\s]+)/i)?.[1];
    if (properties) {
      speciesColumn = -1; positionColumn = -1;
      const schema = properties.split(':');
      if (schema.length % 3) throw new Error('扩展XYZ的Properties列定义不完整。');
      for (let k = 0; k < schema.length; k += 3) {
        const width = Number(schema[k + 2]);
        if (!Number.isInteger(width) || width < 1) throw new Error('扩展XYZ列宽无效。');
        if (schema[k] === 'species' && schema[k + 1] === 'S' && width === 1) speciesColumn = totalColumns;
        if (schema[k] === 'pos' && schema[k + 1] === 'R' && width === 3) positionColumn = totalColumns;
        totalColumns += width;
      }
      if (speciesColumn < 0 || positionColumn < 0) throw new Error('该扩展XYZ必须含species:S:1与pos:R:3，不能猜测坐标列。');
    }
    const structure = base(name, 'XYZ', structures.length);
    const scale = /\b(?:units\s*=\s*|units\s*:\s*)bohr\b/i.test(comment) ? BOHR_TO_ANGSTROM : 1;
    if (/\bunits\s*[=:]/i.test(comment) && scale === 1 && !/\bunits\s*[=:]\s*(?:angstrom|ang|a)\b/i.test(comment)) throw new Error('XYZ声明的单位未覆盖，不能默认为Å。');
    for (let j = 0; j < n; j++) {
      const row = lines[i++]?.trim().split(/\s+/);
      if (!row || row.length < 4) throw new Error(`XYZ第${j + 1}个原子行缺失或不完整。`);
      if (totalColumns && row.length !== totalColumns) throw new Error('扩展XYZ实际列数与Properties声明不一致。');
      structure.atoms.push(atom(row[speciesColumn], row[positionColumn], row[positionColumn + 1], row[positionColumn + 2], scale));
    }
    const metadata = (pattern: RegExp): number | null => {
      const value = comment.match(pattern)?.[1];
      if (value === undefined) return null;
      if (!/^[+-]?\d+$/.test(value)) throw new Error('XYZ电荷/多重度元数据不是整数。');
      return Number(value);
    };
    structure.charge = metadata(/\bcharge\s*=\s*([^\s]+)/i);
    structure.multiplicity = metadata(/\b(?:multiplicity|mult)\s*=\s*([^\s]+)/i);
    if (scale !== 1) structure.notes.push('来源明确标记Bohr，已转换为Å。');
    if (/\bLattice=/i.test(comment)) structure.notes.push('来源含周期晶胞信息；本原型只生成有限分子输入，请确认选取的结构。');
    structures.push(structure);
  }
  if (!structures.length) throw new Error('XYZ中没有可读取的结构。');
  return structures;
}

function parseGjf(text: string, name: string): Structure[] {
  return text.split(/^\s*--Link1--\s*$/im).map((job, index) => {
    const lines = job.split('\n');
    let i = lines.findIndex(line => /^\s*#/.test(line));
    if (i < 0) throw new Error('没有找到Gaussian的#关键词行。');
    const routeStart=i;const route: string[] = [];
    while (i < lines.length && lines[i].trim()) route.push(lines[i++].trim());
    while (i < lines.length && !lines[i].trim()) i++;
    const titleStart=i;while (i < lines.length && lines[i].trim()) i++;
    const title=lines.slice(titleStart,i).join(' ');
    while (i < lines.length && !lines[i].trim()) i++;
    if (!/^\s*[+-]?\d+\s+\d+(?:\s+[+-]?\d+\s+\d+)*\s*$/.test(lines[i] ?? '')) throw new Error('未找到完整电荷/多重度行，或输入含未覆盖的电子态。');
    const states=lines[i++].trim().split(/\s+/).map(Number);const [charge, multiplicity] = states;
    const structure = base(name, 'GJF / COM', index);
    structure.charge = charge; structure.multiplicity = multiplicity;
    structure.sourceRoute = route.join(' ');
    const source=parseGaussianSource(structure.sourceRoute,'gjf',name,index);source.title=title;source.charge=charge;source.multiplicity=multiplicity;applyGaussianLink0(source,lines.slice(0,routeStart));
    structure.gaussianSource=source;const fragments=new Map<number,number[]>();const layers=new Map<string,number[]>();
    if (/\bgeom\s*=\s*(?:\()?\s*(allcheck|check)/i.test(structure.sourceRoute)) throw new Error('这个GJF从CHK读取几何，没有独立完整坐标；请提供含显式坐标的GJF或FCHK。');
    const bohr = /\bunits\s*=\s*\(?\s*(?:bohr|au)\b/i.test(structure.sourceRoute);
    if (/\bunits\s*=/i.test(structure.sourceRoute) && !bohr && !/\bunits\s*=\s*\(?\s*angstrom/i.test(structure.sourceRoute)) throw new Error('该GJF的Units写法暂未覆盖，不能擅自假定坐标单位。');
    const translations:Vector3[]=[];
    while (i < lines.length && lines[i].trim()) {
      const cleaned = lines[i++].split('!')[0].trim();
      if (!cleaned) continue;
      const row = cleaned.replace(/,(?![^()]*\))/g,' ').trim().split(/\s+/);const oniom=/\boniom\s*\(/i.test(structure.sourceRoute);const frozen=/^(0|-1)$/.test(row[1])&&(oniom?row.length>=6:row.length===5);const offset=frozen?2:1;
      if(/^Tv$/i.test(row[0])){
        if(row.length!==4||translations.length===3)throw new Error('Gaussian周期来源须含1至3条完整Tv矢量。');
        const vector=row.slice(1).map(token=>numberValue(token)*(bohr?BOHR_TO_ANGSTROM:1)) as Vector3;
        if(norm3(vector)<1e-10)throw new Error('Gaussian Tv平移矢量不能为零。');
        translations.push(vector);continue;
      }
      if(translations.length)throw new Error('Gaussian Tv矢量须位于全部原子之后，不能混入原子坐标。');
      const fragment=row[0].match(/^([A-Za-z]{1,2}|\d+)\(Fragment=(\d+)\)$/i);
      if(row.length!==offset+3&&!(oniom&&row.length>=offset+4&&/^[HML]$/i.test(row[offset+3])))throw new Error('本原型只读取普通显式Cartesian坐标，不展开Z-matrix或特殊原子标签。');
      const symbol=fragment?.[1]??(oniom?row[0].match(/^[A-Za-z]{1,2}/)?.[0]:row[0]);
      if(!symbol)throw new Error('原子标签不能可靠识别元素。');
      structure.atoms.push(atom(symbol, row[offset], row[offset + 1], row[offset + 2], bohr ? BOHR_TO_ANGSTROM : 1));
      const atomIndex=structure.atoms.length;if(frozen&&row[1]==='-1')source.frozenAtoms!.push(atomIndex);
      if(fragment){const id=Number(fragment[2]);fragments.set(id,[...(fragments.get(id)??[]),atomIndex]);}
      if(oniom){const layer=row[offset+3].toUpperCase();layers.set(layer,[...(layers.get(layer)??[]),atomIndex]);}
    }
    checkCount(structure.atoms.length);
    if(translations.length===2&&norm3(cross3(translations[0],translations[1]))<1e-10)throw new Error('Gaussian两条Tv平移矢量线性相关。');
    if(translations.length===3){
      structure.cell={vectors:translations as [Vector3,Vector3,Vector3],pbc:[true,true,true],source:name,pbcProvenance:{kind:'format-defined',evidence:'Gaussian分子规格末尾的3条Tv分别定义三个周期平移方向。'}};
      cellInverse(structure.cell);structure.notes.push('3条Tv已作为真实晶胞平移矢量读取，不计入原子；周期方向按Gaussian格式为三维，不从同名CIF继承二维标记。');
    }else if(translations.length){
      structure.periodicSource={translationVectors:translations,completeness:'partial',evidence:`Gaussian来源给出${translations.length}条Tv，定义${translations.length}维周期平移；未提供其余完整晶胞矢量。`};
      source.issues.push({code:'periodic-cell-incomplete',field:'geometry',severity:'missing',message:'已保留原子及Tv平移信息；缺少完整晶胞，不作为有限分子或完整周期来源运行。'});
      structure.notes.push(structure.periodicSource.evidence+'保留可读原子，运行前须补齐完整晶胞，未虚构非周期方向盒长。');
    }
    if(fragments.size){const count=Number(structure.sourceRoute.match(/counterpoise\s*=\s*(\d+)/i)?.[1]??Math.max(...fragments.keys()));source.fragments=Array.from({length:count},(_,j)=>({atoms:fragments.get(j+1)??[],charge:states[2+j*2]??0,multiplicity:states[3+j*2]??1}));if(states.length!==2+count*2)source.issues.push({code:'fragment-states',message:'来源片段电荷/多重度不完整，不能用默认值冒充继承。',field:'state',severity:'missing'});}
    if(layers.size)source.layers=[...layers].map(([layer,atoms])=>({atoms,label:layer==='H'?'QM':layer==='L'?'MM':'Middle',kind:layer==='H'?'qm':layer==='L'?'mm':'middle'}));
    applyGaussianTail(source,lines.slice(i).join('\n'),structure.atoms.length,structure.atoms.map(atom=>atom.element));
    structure.notes.push('已读取来源路由、电子态与可识别冻结/附加段；仅在主动选择继承时应用，并保留未覆盖项供核对。');
    if (bohr) structure.notes.push('来源为Bohr坐标，已转换为Å。');
    return structure;
  });
}

function parsePdb(text: string, name: string): Structure[] {
  const models: string[][] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (/^MODEL\s/.test(line)) { if (current.length) models.push(current); current = []; }
    else if (/^ENDMDL/.test(line)) { if (current.length) models.push(current); current = []; }
    else if (/^(ATOM  |HETATM)/.test(line)) current.push(line);
  }
  if (current.length) models.push(current);
  if (!models.length) throw new Error('PDB中没有ATOM/HETATM记录。');
  const structures: Structure[] = [];
  models.forEach((model, modelIndex) => {
    const alternates = [...new Set(model.map(line => line[16]?.trim()).filter(Boolean))];
    for (const alternate of alternates.length ? alternates : ['']) {
      const structure = base(name, `PDB · 模型${modelIndex + 1}${alternate ? ` · 替代位置${alternate}` : ''}`, structures.length);
      const chosen = model.filter(line => !line[16]?.trim() || line[16].trim() === alternate);
      for (const line of chosen) {
        let element = line.slice(76, 78).trim();
        if (!element) {
          const raw = line.slice(12, 16);
          const letters = raw.replace(/^\d+/, '').trim();
          element = /^\s|^\d/.test(raw) ? letters[0] : letters.slice(0, 2);
          try { elementSymbol(element); } catch { element = letters[0]; }
        }
        const sourceIndex = Number(line.slice(6, 11).trim());
        if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 1) throw new Error('PDB来源原子序号无效。');
        structure.atoms.push({ ...atom(element, line.slice(30, 38).trim(), line.slice(38, 46).trim(), line.slice(46, 54).trim()), sourceIndex });
      }
      checkCount(structure.atoms.length);
      structure.notes.push('PDB一般不含可靠总电荷/多重度；只保留显式原子，不补氢。');
      if (alternates.length) structure.notes.push(`当前构型使用替代位置${alternate}及公共原子，请明确核对构型。`);
      structures.push(structure);
    }
  });
  return structures;
}

function parseMolRecord(record: string, name: string, index: number): Structure {
  const sourceLines = record.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    let line = sourceLines[i];
    while (/^M\s+V30\b.*-\s*$/.test(line)) {
      const next = sourceLines[++i];
      if (!next || !/^M\s+V30\s/.test(next)) throw new Error('V3000续行截断。');
      line = line.replace(/-\s*$/, '') + next.replace(/^M\s+V30\s*/, '');
    }
    lines.push(line);
  }
  record = lines.join('\n');
  if (!/^M\s+END\s*$/m.test(record)) throw new Error('MOL/SDF缺少M END，文件可能截断。');
  if (/^M\s+ISO\b/m.test(record) || /\bMASS=\d+/.test(record)) throw new Error('文件含指定同位素，当前输入生成器尚未保留同位素质量；请勿将其当普通元素静默导出。');
  const structure = base(name, /V3000/.test(record) ? 'MOL / SDF V3000' : 'MOL / SDF V2000', index);
  structure.dimension = /\b2D\b|2D\s*$/i.test(lines[1] ?? '') ? 2 : 3;
  structure.molfile = record;
  structure.bonds = []; structure.bondSource = 'file';
  const charges = new Map<number, number>();
  const atomIds = new Map<number, number>();
  if (/V3000/.test(record)) {
    const n = Number(record.match(/M\s+V30\s+COUNTS\s+(\d+)/)?.[1]); checkCount(n);
    const start = lines.findIndex(line => /M\s+V30\s+BEGIN ATOM/.test(line));
    const end = lines.findIndex(line => /M\s+V30\s+END ATOM/.test(line));
    if (start < 0 || end <= start) throw new Error('V3000原子段不完整。');
    let hasUnconvertedAtomCfg = false;
    for (const line of lines.slice(start + 1, end)) {
      const row = line.trim().split(/\s+/);
      if (row[0] !== 'M' || row[1] !== 'V30' || row.length < 8) throw new Error('V3000原子行不完整。');
      const id = Number(row[2]);
      if (!Number.isSafeInteger(id) || id < 1 || charges.has(id)) throw new Error('V3000原子编号重复或无效。');
      structure.atoms.push({ ...atom(row[3], row[4], row[5], row[6]), sourceIndex: id });
      atomIds.set(id, structure.atoms.length - 1);
      charges.set(Number(row[2]), Number(line.match(/\bCHG=([+-]?\d+)/)?.[1] ?? 0));
      if (/\bCFG=[123]\b/.test(line)) hasUnconvertedAtomCfg = true;
    }
    if (hasUnconvertedAtomCfg) structure.notes.push('来源原子CFG立体标签未转换，当前保留坐标与已支持键标签；原始标签保留在连接表中。');
    if (structure.atoms.length !== n) throw new Error('V3000原子数与声明不一致。');
    const bonds = Number(record.match(/M\s+V30\s+COUNTS\s+\d+\s+(\d+)/)?.[1]);
    if (!Number.isInteger(bonds) || bonds < 0) throw new Error('V3000键数无效。');
    const bondStart = lines.findIndex(line => /M\s+V30\s+BEGIN BOND/.test(line));
    const bondEnd = lines.findIndex(line => /M\s+V30\s+END BOND/.test(line));
    if (bonds && (bondStart < 0 || bondEnd <= bondStart)) throw new Error('V3000键段截断。');
    const bondLines = bondStart >= 0 ? lines.slice(bondStart + 1, bondEnd) : [];
    if (bondLines.length !== bonds) throw new Error('V3000键数与声明不一致。');
    const bondIds = new Set<number>();
    for (const line of bondLines) {
      const row = line.trim().split(/\s+/);
      const id = Number(row[2]);
      if (!Number.isInteger(id) || id < 1 || bondIds.has(id) || !charges.has(Number(row[4])) || !charges.has(Number(row[5])) || row[4] === row[5]) throw new Error('V3000键编号/引用无效。');
      if(![1,2,3,4].includes(Number(row[3])))throw new Error('V3000查询键/未知键级尚未支持。');
      const configurations = [...line.matchAll(/\bCFG=([^\s]+)/g)];
      const cfg = Number(configurations[0]?.[1] ?? 0), order = Number(row[3]);
      if (configurations.length > 1 || !Number.isInteger(cfg) || ![0, 1, 2, 3].includes(cfg)) throw new Error('V3000键CFG标记无效或重复。');
      if (cfg && (order !== 1 && order !== 2 || order === 2 && cfg !== 2)) throw new Error('V3000键CFG与键类型不一致。');
      // CTfile bond CFG 1/2/3 = up/either/down. Keep the first endpoint
      // (the narrow wedge end); this is not atom CFG or stable-ID parity.
      // V2000 uses a distinct either code for single (4) and double (3).
      const stereo = cfg === 2 ? order === 2 ? 3 : 4 : cfg === 3 ? 6 : cfg;
      bondIds.add(id);
      structure.bonds.push({ a: atomIds.get(Number(row[4]))!, b: atomIds.get(Number(row[5]))!, order: order === 4 ? 1 : order, aromatic: order === 4, ...(stereo ? { stereo } : {}) });
    }
  } else {
    const countIndex = lines.findIndex(line => /V2000/.test(line));
    if (countIndex < 0) throw new Error('未找到MOL/SDF的V2000/V3000计数行。');
    const n = Number(lines[countIndex].slice(0, 3).trim()); checkCount(n);
    const bondCount = Number(lines[countIndex].slice(3, 6).trim());
    if (!Number.isInteger(bondCount) || bondCount < 0) throw new Error('MOL/SDF键数声明无效。');
    const chargeCode: Record<number, number> = { 1: 3, 2: 2, 3: 1, 5: -1, 6: -2, 7: -3 };
    for (let j = 0; j < n; j++) {
      const row = lines[countIndex + 1 + j];
      if (!row || row.length < 34) throw new Error('MOL/SDF原子段截断。');
      if (Number(row.slice(34, 36).trim()) !== 0) throw new Error('文件含同位素质量差，当前版本尚未输出同位素设置。');
      structure.atoms.push(atom(row.slice(31, 34).trim(), row.slice(0, 10).trim(), row.slice(10, 20).trim(), row.slice(20, 30).trim()));
      charges.set(j + 1, chargeCode[Number(row.slice(36, 39).trim())] ?? 0);
    }
    for (let j = 0; j < bondCount; j++) {
      const row = lines[countIndex + 1 + n + j];
      if (!row || row.length < 9 || !/^\s*\d+$/.test(row.slice(0, 3)) || !/^\s*\d+$/.test(row.slice(3, 6))) throw new Error('MOL/SDF键段截断或格式无效。');
      const ends = [Number(row.slice(0, 3)), Number(row.slice(3, 6))];
      if (ends.some(id => !Number.isInteger(id) || id < 1 || id > n) || ends[0] === ends[1]) throw new Error('MOL/SDF键引用了无效原子。');
      const order = Number(row.slice(6,9));
      if (![1,2,3,4].includes(order)) throw new Error('MOL含查询键/未指定键级，暂不作为普通分子拓扑导入。');
      structure.bonds.push({ a: ends[0]-1, b: ends[1]-1, order: order === 4 ? 1 : order, aromatic: order === 4, stereo: Number(row.slice(9,12)) || undefined });
    }
    for (const line of lines) {
      if (!/^M\s+CHG\b/.test(line)) continue;
      const row = line.trim().split(/\s+/);
      const entries = Number(row[2]);
      if (!Number.isInteger(entries) || entries < 0 || row.length !== 3 + entries * 2) throw new Error('M CHG电荷记录不完整。');
      for (let j = 0; j < entries; j++) {
        const id = Number(row[3 + j * 2]);
        const value = Number(row[4 + j * 2]);
        if (!Number.isInteger(id) || id < 1 || id > n || !Number.isInteger(value)) throw new Error('M CHG引用了不存在的原子或含无效电荷。');
        charges.set(id, value);
      }
    }
  }
  structure.charge = [...charges.values()].reduce((total, value) => total + value, 0);
  for (const [id, charge] of charges) if (charge) structure.atoms[/V3000/.test(record) ? atomIds.get(id)! : id-1].formalCharge = charge;
  if (structure.dimension === 2) structure.notes.push('来源为二维连接表，需在编辑器生成三维后才能导出量化坐标。');
  structure.notes.push('读取形式电荷；自旋仍需确认。只保留文件中的显式原子，不自动补氢或把二维坐标变成三维。');
  return structure;
}

function parseMol(text: string, name: string): Structure[] {
  return text.split(/^\$\$\$\$\s*$/m).map((record, index) => index > 0 ? record.replace(/^\n/, '') : record).filter(record => record.trim()).map((record, index) => parseMolRecord(record, name, index));
}

function parseFchk(text: string, name: string): Structure[] {
  const reader=new FchkReader();for(const record of fchkTextRecords(text))reader.consume(record.text,{sourceLine:record.sourceLine,byteProven:true});return reader.finish(name);
}

export function parseStructures(raw: string, name: string): Structure[] {
  assertNoMol2Source(raw, name);
  if (!raw.trim()) throw new Error('文件为空。');
  const fchkInput=looksLikeFchk(raw);
  if (raw.includes('\0')&&!fchkInput) throw new Error('检测到二进制或UTF-16内容，请另存UTF-8文本；二进制CHK不能当结构文本读取。');
  const text = fchkInput?raw.replace(/^\uFEFF/,''):raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const periodic = fchkInput?null:parsePeriodicStructures(text, name);
  if (periodic) return periodic;
  let extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() : '';
  const identity:ReturnType<typeof recognizeSourceText> = fchkInput?{format:'fchk',software:'unknown',status:'recognized',evidence:[]}:recognizeSourceText(text);
  if (identity.status === 'conflict') throw new Error(identity.message);
  if (identity.software === 'cp2k' && identity.format === 'output') throw new Error('识别为CP2K输出；本入口尚不支持CP2K结果结构解析。');
  if (identity.format === 'output' && (identity.software === 'gaussian' || identity.software === 'orca')) extension = 'out';
  else if (identity.format === 'fchk') extension = 'fchk';
  else if (identity.format === 'xyz') extension = 'xyz';
  const detected = extension === 'txt' || !extension;
  if (detected) {
    if (/^\s*#[pnt]?\s+/im.test(text)) extension = 'gjf';
    else if (/^.{0,40}V[23]000\s*$/m.test(text)) extension = 'mol';
    else if (/^(ATOM  |HETATM)/m.test(text)) extension = 'pdb';
    else if (/^\s*\d+\s*\n/.test(text)) extension = 'xyz';
    else if (/^\s*\*\s*xyz(?:file)?\b/im.test(text)) extension = 'inp';
  }
  let structures: Structure[];
  if (extension === 'xyz') structures = parseXyz(text, name);
  else if (extension === 'gjf' || extension === 'com') structures = parseGjf(text, name);
  else if (extension === 'pdb') structures = parsePdb(text, name);
  else if (extension === 'mol' || extension === 'sdf') structures = parseMol(text, name);
  else if (extension === 'fch' || extension === 'fchk') structures = parseFchk(text, name);
  else if (extension === 'inp') structures = parseOrcaInput(text, name);
  else if (extension === 'out' || extension === 'log') structures = parseQuantumOutput(text, name);
  else throw new Error('支持XYZ/扩展XYZ、CIF、POSCAR、PDB、MOL/SDF、CP2K INP/restart、GJF/COM、FCH/FCHK及Gaussian/ORCA输出。');
  if (!structures.length) throw new Error('没有可读取的结构。');
  for (const structure of structures) {
    if (structure.charge !== null && !Number.isSafeInteger(structure.charge)) throw new Error('来源电荷不是安全整数。');
    if (structure.multiplicity !== null && (!Number.isSafeInteger(structure.multiplicity) || structure.multiplicity < 1)) throw new Error('来源多重度须为正整数。');
    if (detected) structure.notes.unshift(`按文本内容识别为${structure.format}，请核对。`);
  }
  return structures;
}
