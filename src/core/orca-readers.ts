import { atomicNumber, elementSymbol } from './elements';
import type { Atom, Structure } from './types';
import { orcaNativeJobNumber, orcaSourceKeywords, orcaSourceLine, parseOrcaInputSource } from './orca/input-source';
import { outputSoftwareOnLine } from '../results/source-recognition';
import { OrcaAuTableReader, pairOrcaCenterTables, readOrcaAngCenter, type OrcaAngCenter, type OrcaAuTable } from './orca/output-centers';
const bohr = 0.529177210903;
/** Source centers are not display Atoms. A ghost has a basis center but no real nucleus. */
export interface OrcaInputCenter {
  sourceIndex: number; sourceLine: number; kind: 'real' | 'ghost' | 'dummy';
  element: string | null; nuclearCharge: number | null;
  coordinates?: [number, number, number]; coordinateUnit?: 'angstrom' | 'bohr';
}
export interface OrcaInputCenterEvidence {
  jobIndex: number; charge: number | null; multiplicity: number | null;
  rawInput: string; sourceLine: number; centers: OrcaInputCenter[];
}
/** Input-only evidence; never certifies an executed job or converts ghost centers to atoms. */
export function readOrcaInputCenters(text: string): OrcaInputCenterEvidence[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), result: OrcaInputCenterEvidence[] = [];
  let jobStart = 0, jobIndex = 0, totalCenters = 0;
  for (let boundary = 0; boundary <= lines.length; boundary++) {
    if (boundary < lines.length && !/^\s*\$new_job\s*$/i.test(orcaSourceLine(lines[boundary]))) continue;
    const jobLines = lines.slice(jobStart, boundary), rawInput = jobLines.join('\n');
    for (let index = 0; index < jobLines.length; index++) {
      const header = orcaSourceLine(jobLines[index]).match(/^\s*\*\s*xyz\s+([+-]?\d+)\s+(\d+)\s*$/i);
      if (!header) continue;
      const sourceLine = jobStart + index + 1, centers: OrcaInputCenter[] = [];
      let closed = false;
      const keywords = orcaSourceKeywords(rawInput), unit = keywords.some(keyword => /^bohrs$/i.test(keyword)) ? 'bohr' as const : 'angstrom' as const;
      if (unit === 'bohr' && keywords.some(keyword => /^angs$/i.test(keyword))) throw new Error('ORCA来源同时声明Bohrs与Angs单位，不能猜测坐标单位。');
      for (index++; index < jobLines.length; index++) {
        const row = orcaSourceLine(jobLines[index]).trim();
        if (row === '*') { closed = true; break; }
        if (!row) continue;
        const fields = row.split(/\s+/), ghost = /^([A-Za-z]{1,2}):$/.exec(fields[0]), dummy = /^DA$/i.test(fields[0]);
        if (fields.length !== 4) throw new Error('ORCA中心坐标行不完整或含额外核/基组定义，未丢弃字段。');
        const coordinates = fields.slice(1).map(value => Number(value.replace(/[dD]/, 'e'))) as [number, number, number];
        if (!coordinates.every(Number.isFinite)) throw new Error('ORCA中心坐标不是有限数字。');
        const element = dummy ? null : elementSymbol(ghost?.[1] ?? fields[0]);
        totalCenters++;
        centers.push({ sourceIndex: centers.length + 1, sourceLine: jobStart + index + 1, kind: ghost ? 'ghost' : dummy ? 'dummy' : 'real', element, nuclearCharge: ghost ? 0 : element === null ? null : atomicNumber(element), coordinates, coordinateUnit: unit });
      }
      if (!closed) throw new Error('ORCA中心坐标段未闭合；不能认证完整中心列表。');
      const q = Number(header[1]), m = Number(header[2]);
      result.push({ jobIndex, charge: Number.isSafeInteger(q) ? q : null, multiplicity: Number.isSafeInteger(m) && m >= 1 ? m : null, rawInput, sourceLine, centers });
    }
    jobStart = boundary + 1; jobIndex++;
  }
  return result.some(job => job.centers.some(center => center.kind !== 'real')) ? result : [];
}
function rowAtom(row: string, scale = 1): Atom {
  const fields = row.trim().split(/\s+/);
  if (fields.length === 5 && /^\d+$/.test(fields[0])) fields.shift();
  if (fields.length !== 4) throw new Error('ORCA坐标行不完整或含ghost/特殊核定义，不能丢弃这些字段。');
  const coords = fields.slice(1).map(value => Number(value.replace(/[dD]/, 'e')) * scale);
  if (!coords.every(Number.isFinite)) throw new Error('ORCA坐标不是有限数字。');
  return { element: elementSymbol(fields[0]), x:coords[0], y:coords[1], z:coords[2] };
}
export function referencedXyz(text: string): string[] {
  return [...text.matchAll(/^\s*\*\s*xyzfile\s+[+-]?\d+\s+\d+\s+(?:"([^"]+)"|([^\s#]+))/gim)].map(match => (match[1] ?? match[2]).replace(/\\/g,'/').split('/').at(-1)!);
}
export function parseOrcaInput(text: string, name: string, external: Record<string, Structure[]> = {}): Structure[] {
  const lines = text.replace(/\r\n?/g,'\n').split('\n'); const result: Structure[] = [];
  const sourceText = (header: number) => {
    let first = header, last = header + 1;
    while (first > 0 && !/^\s*\$new_job\s*$/i.test(orcaSourceLine(lines[first - 1]))) first--;
    while (last < lines.length && !/^\s*\$new_job\s*$/i.test(orcaSourceLine(lines[last]))) last++;
    return lines.slice(first, last).join('\n');
  };
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\*\s*(xyz|xyzfile)\s+([+-]?\d+)\s+(\d+)\s*(.*?)\s*$/i);
    if (!header) continue;
    const charge = Number(header[2]); const multiplicity = Number(header[3]);
    if (!Number.isSafeInteger(charge) || !Number.isSafeInteger(multiplicity) || multiplicity < 1) throw new Error('ORCA电子态行无效。');
    const rawInput = sourceText(i);
    if (header[1].toLowerCase() === 'xyzfile') {
      const filename = orcaSourceLine(header[4]).trim().replace(/^"|"$/g,'').replace(/\\/g,'/').split('/').at(-1)!;
      const matches = Object.keys(external).filter(key => key.toLowerCase() === filename.toLowerCase());
      if (!filename || matches.length !== 1) throw new Error('ORCA输入引用外部XYZ：' + (filename || '未给文件名') + '。请与INP一起选择对应XYZ，不能仅凭INP恢复几何。');
      for (const structure of external[matches[0]]) result.push({ ...structure, id:name+'-'+result.length, name, format:'ORCA INP + XYZ', charge,multiplicity, sourceRoute:undefined, gaussianSource:undefined, gaussianSources:undefined,
        orcaSource:parseOrcaInputSource(rawInput,name,result.length,structure.atoms.length,charge,multiplicity), notes:[...structure.notes,'已配对外部XYZ：'+matches[0]+'；来源级别/冻结只作证据，不自动采用来源任务。'] });
    } else {
      const atoms: Atom[] = []; let closed = false;
      const sourceKeywords = orcaSourceKeywords(rawInput), hasBohrs = sourceKeywords.some(keyword => /^bohrs$/i.test(keyword));
      if (hasBohrs && sourceKeywords.some(keyword => /^angs$/i.test(keyword))) throw new Error('ORCA来源同时声明Bohrs与Angs单位，不能猜测坐标单位。');
      const scale = hasBohrs ? bohr : 1;
      for (i++; i < lines.length; i++) {
        const row = orcaSourceLine(lines[i]).trim();
        if (row === '*') { closed = true; break; }
        if (row) atoms.push(rowAtom(row, scale));
      }
      if (!closed || !atoms.length) throw new Error('ORCA显式XYZ坐标段未闭合或为空。');
      result.push({ id:name+'-'+result.length,name,format:'ORCA INP',atoms,charge,multiplicity,dimension:3,
        orcaSource:parseOrcaInputSource(rawInput,name,result.length,atoms.length,charge,multiplicity), notes:['已保存来源级别、冻结与扫描证据；导入不自动采用来源任务、方法或约束。',...(scale !== 1 ? ['来源Bohr已转Å。'] : [])] });
    }
  }
  if (!result.length) throw new Error('ORCA INP未找到支持的* xyz坐标段；内坐标、分层和特殊中心需另行处理。');
  return result;
}
export class OrcaOutputReader {
  private inCoordinates = false; private started = false; private current: Atom[] = []; private malformed = false;
  private expected: number | null = null; private last: Atom[] | null = null; private seenOrca = false; private truncated = false;
  private frequencySection = false; private optimized = false; private terminated = false; private charge: number | null = null; private mult: number | null = null;
  private dipoleProperty = false; private dipoleMagnitude = false;
  private lineNumber = 0; private auReader = new OrcaAuTableReader();
  private currentAng: OrcaAngCenter[] = [];
  private auCandidate: { rows: OrcaAngCenter[]; previous: Atom[] | null } | null = null;
  private previousAng: Atom[] | null = null;
  private nuclearIssue: string | null = null;
  private coordinateIssue: string | null = null;
  private nextJob() {
    this.finishBlock(); this.last = null; this.expected = null; this.frequencySection = false;
    this.optimized = false; this.terminated = false; this.charge = null; this.mult = null; this.truncated = false;
    this.dipoleProperty = false; this.dipoleMagnitude = false;
    this.auReader.reset(); this.auCandidate = null; this.currentAng = []; this.previousAng = null; this.nuclearIssue = null; this.coordinateIssue = null;
  }
  private applyNuclearTable(table: OrcaAuTable) {
    const candidate = this.auCandidate; this.auCandidate = null;
    const paired = pairOrcaCenterTables(candidate?.rows ?? [], table);
    if (!candidate && !paired.special || paired.matched && !paired.special) return;
    if (paired.independentReal) { this.coordinateIssue = '完整同数同序全实核Å/A.U.表坐标冲突；保留独立Å几何，未融合A.U.坐标或跨表核性质。'; return; }
    this.last = candidate ? candidate.previous : this.last;
    this.nuclearIssue = '当前段含ghost/dummy或不相容的核/基组中心证据；未把plain元素标签当成全部真核。' + paired.message;
  }
  consume(line: string) {
    this.lineNumber++;
    if (/^\s*(?:\|\s*\d+>|#)/.test(line)) return;
    const software = outputSoftwareOnLine(line);
    if (software && software !== 'orca') throw new Error('来源身份不是ORCA，未作为ORCA结构解析。');
    if (software === 'orca') { if (this.seenOrca) this.nextJob(); this.seenOrca = true; }
    if (orcaNativeJobNumber(line) !== null || /^\s*COMPOUND JOB\s+\d+\s*$/i.test(line)) this.nextJob();
    if (/^\s*DIPOLE MOMENT\s*$/i.test(line)) { this.dipoleProperty = true; this.dipoleMagnitude = false; }
    if (this.dipoleProperty && /^\s*Magnitude\s*\(/i.test(line)) this.dipoleMagnitude = true;
    if (this.dipoleProperty && this.dipoleMagnitude && !line.trim()) this.dipoleProperty = false;
    const count = line.match(/^\s*(?:Number of atoms|# of atoms)\s*[.:=]*\s*(\d+)\s*$/i); if (count) {this.expected = Number(count[1]);if(!Number.isSafeInteger(this.expected)||this.expected<1)throw new Error('ORCA原子数须为正安全整数。');}
    const charge = this.dipoleProperty ? null : line.match(/^\s*Total Charge(?:\s+Charge)?\s*[.:=]*\s*([+-]?\d+)\s*$/i); if (charge) this.charge=Number(charge[1]);
    const mult = this.dipoleProperty ? null : line.match(/^\s*Multiplicity(?:\s+Mult)?\s*[.:=]*\s*(\d+)\s*$/i); if (mult) this.mult=Number(mult[1]);
    if (/^\s*\**\s*THE OPTIMIZATION HAS CONVERGED\b/i.test(line)) this.optimized=true;
    if (/^\s*\**\s*ORCA TERMINATED NORMALLY\s*\**\s*$/i.test(line)) this.terminated=true;
    if (/NUMERICAL FREQUENCIES|VIBRATIONAL FREQUENCIES|NUMERICAL HESSIAN/i.test(line)) { this.finishBlock(); this.frequencySection=true; this.auCandidate = null; this.auReader.reset(); }
    if (/^\s*GEOMETRY OPTIMIZATION CYCLE\s+\d+\b|^\s*FINAL ENERGY EVALUATION AT THE STATIONARY POINT\b/i.test(line)) this.frequencySection = false;
    if (!this.frequencySection) {
      const au = this.auReader.consume(line, this.lineNumber);
      if (au.started) this.finishBlock();
      if (au.table) this.applyNuclearTable(au.table);
      if (au.consumed) return;
    }
    if (/CARTESIAN COORDINATES\s*\((?:ANGSTROEM|ANGSTROM)\)/i.test(line)) {
      this.finishBlock(); if (!this.frequencySection) { this.previousAng = this.last; this.inCoordinates=true; this.started=false; this.current=[]; this.currentAng=[]; this.malformed=false; this.nuclearIssue = null; } return;
    }
    if (!this.inCoordinates) return;
    if (!line.trim() || /^\s*-+\s*$/.test(line)) { if (this.started) this.finishBlock(); return; }
    this.started=true;
    const center = readOrcaAngCenter(line, this.lineNumber, this.currentAng.length + 1);
    if (center) {
      this.currentAng.push(center);
      if (center.kind !== 'real' || center.element === null) this.malformed = true;
      else this.current.push({ element: center.element, x: center.coordinates[0], y: center.coordinates[1], z: center.coordinates[2] });
    } else { this.malformed = true; this.finishBlock(); }
  }
  private finishBlock(eof=false) {
    if (!this.inCoordinates) return;
    if (!this.malformed && this.current.length && (this.expected === null ? !eof : this.current.length === this.expected)) { this.last=this.current; this.expected=this.current.length; }
    else if (this.started) this.truncated=true;
    this.inCoordinates=false;
    if (this.currentAng.length) this.auCandidate = { rows: this.currentAng, previous: this.previousAng };
  }
  finish(name: string): Structure[] {
    this.finishBlock(true);
    const au = this.auReader.finish(); if (au) this.applyNuclearTable(au);
    if (!this.seenOrca || !this.last) throw new Error('没有找到当前ORCA作业可用于普通原子模型的完整Å坐标，未跨作业借用旧结构。' + (this.nuclearIssue ?? ''));
    return [{ id:name+'-last',name,format:'ORCA OUT',atoms:this.last,charge:this.charge,multiplicity:this.mult,dimension:3,notes:['提取当前作业最后完整几何；'+(this.optimized?'检测到优化收敛标记。':'未认证结构优化收敛。'),this.terminated?'检测到ORCA正常终止。':'未观察到正常终止；静态文件不能据此判断程序是否仍在运行。',...(this.truncated?['尾部坐标不完整，已回退同一作业较早完整帧。']:[]),...(this.nuclearIssue ? [this.nuclearIssue + '仅保较早完整普通结构。'] : []),...(this.coordinateIssue ? [this.coordinateIssue] : []),'只读几何及元数据，不执行后处理或继承ORCA关键词。'] }];
  }
}
export function parseOrcaOutput(text: string, name: string): Structure[] { const reader = new OrcaOutputReader(); const lines=text.replace(/\r\n?/g,'\n').split('\n'); if(lines.at(-1)==='')lines.pop(); for (const line of lines) reader.consume(line); return reader.finish(name); }
