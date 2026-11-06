import { getOrcaMethods, ORCA_BASES } from './catalog';
import { getSolventEntries } from '../solvents';
import type { SourceIssue } from '../gaussian-source';
import type { OrcaInputSourceMeta, OrcaSourceCoordinate } from './types';

/** Hash comments only outside quotes; the retained original input is untouched. */
export function orcaSourceLine(line: string): string {
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const ch = line[index];
    if (quote) { if (ch === quote && line[index - 1] !== '\\') quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, index);
  }
  return line;
}

/** Native job titles may be plain or have paired dollar/star decoration.
 * An input echo, comment, quoted title or prose mention is never a boundary. */
export function orcaNativeJobNumber(line: string): number | null {
  const plain = line.match(/^\s*JOB\s+NUMBER\s+([1-9]\d*)\s*$/i);
  const decorated = plain ? null : line.match(/^\s*([$*])\1{2,}\s*JOB\s+NUMBER\s+([1-9]\d*)\s*\1{3,}\s*$/i);
  const raw = plain?.[1] ?? decorated?.[2];
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new Error('ORCA作业编号不是有限安全整数，已停止读取。');
  return number;
}

function tokens(text: string): string[] {
  const result: string[] = []; let token = '', quote = '', depth = 0;
  for (const ch of text) {
    if (quote) { token += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; token += ch; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (token) result.push(token); token = ''; } else token += ch;
  }
  if (token) result.push(token); return result;
}

export function orcaSourceKeywords(input: string): string[] {
  return input.replace(/\r\n?/g, '\n').split('\n').flatMap(line => {
    const clean = orcaSourceLine(line); return /^\s*!/.test(clean) ? tokens(clean.replace(/^\s*!/, '')) : [];
  });
}

interface Block { name: string; body: string; raw: string; closed: boolean }
function blocks(lines: string[]): Block[] {
  const result: Block[] = [];
  const nested = /^(constraints|scan|modify_internal|fragments|new(?:gto|ecp|aux\w*gto)|add(?:gto|aux\w*gto))$/i;
  for (let index = 0; index < lines.length; index++) {
    const match = orcaSourceLine(lines[index]).match(/^\s*%([a-z]\w*)\b(.*)$/i); if (!match) continue;
    const name = match[1].toLowerCase();
    if (['maxcore', 'base', 'moinp', 'pointcharges', 'id'].includes(name)) {
      result.push({ name, body: match[2].trim(), raw: lines[index], closed: true }); continue;
    }
    const first = index; let depth = 1, body = match[2], closed = false;
    for (;;) {
      const words = tokens(index === first ? match[2] : orcaSourceLine(lines[index]));
      for (const word of words) {
        if (nested.test(word)) depth++;
        if (/^end$/i.test(word)) depth--;
      }
      if (depth <= 0) { closed = true; break; }
      if (index + 1 >= lines.length || /^\s*(?:%|\*|\$new_job)/i.test(orcaSourceLine(lines[index + 1]))) break;
      index++; body += '\n' + orcaSourceLine(lines[index]);
    }
    result.push({ name, body, raw: lines.slice(first, index + 1).join('\n'), closed });
  }
  return result;
}

const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eEdD][+-]?\\d+)?';
const finite = (raw: string) => Number(raw.replace(/[dD]/, 'e'));
const knownOther = /^(?:sp|opt|tightopt|looseopt|verytightopt|optts|freq|numfreq|anfreq|irc|engrad|neb(?:-ts|-ci)?|md|nmr|noautostart|moread|miniprint|smallprint|normalprint|largeprint|bohrs|angs|rijcosx|rijonx|ri|rij|rik|rijk|nori|tightscf|strongscf|normalscf|loosescf|verytightscf|slowconv|soscf|nososcf|defgrid[123]|tightpno|normalpno|loosepno)$/i;

/** Limited evidence reader for source level and explicit %geom constraints.
 * No source task, resources, SCF, binary dependency or scan ranges are adopted.
 * Constraint forms follow the ORCA 6.1 geometry/scan manual and our writer.
 */
export function parseOrcaInputSource(rawInput: string, fileName: string, jobIndex: number, atomCount: number, charge: number, multiplicity: number): OrcaInputSourceMeta {
  const lines = rawInput.replace(/\r\n?/g, '\n').split('\n');
  const keywords = orcaSourceKeywords(rawInput);
  const source: OrcaInputSourceMeta = { schema: 1, id: `${fileName}:orca:${jobIndex}`, fileName, jobIndex, rawInput, keywords,
    charge, multiplicity, level: { ecpKeywords: [], dispersion: 'none' }, frozenAtoms: [], coordinates: [], issues: [], unsupported: [] };
  const issue = (code: string, message: string, field: string, raw?: string, severity: SourceIssue['severity'] = 'unsupported') => {
    source.issues.push({ code, message, field, severity, ...(raw ? { raw } : {}) });
    if (raw && severity !== 'warning') source.unsupported.push(raw);
  };
  const methods = getOrcaMethods('6.1');
  const methodMatches = keywords.flatMap(keyword => {
    // Exact ORCA/VWN5 implementation alias; B3LYP/G uses VWN3 and is not equivalent.
    const plain = keyword.toLowerCase().replace(/^m06-2x$/, 'm062x').replace(/^libxc\(\s*b3lyp\s*\)$/, 'b3lyp');
    const match = methods.find(method => method.keywords[0].toLowerCase() === plain);
    return match ? [{ keyword, profile: match }] : [];
  });
  if (methodMatches.length === 1) { source.level.method = methodMatches[0].profile.id; source.level.methodKeyword = methodMatches[0].keyword; }
  else issue('orca-source-method', methodMatches.length ? '来源同时指定多个方法，不能选择最后一项冒充完整级别。' : '未识别当前产品可表达的来源方法；保留来源原文。', 'method', methodMatches.map(match => match.keyword).join(' ') || keywords.join(' '), methodMatches.length ? 'conflict' : 'missing');

  const basisTokens = keywords.filter(keyword => ORCA_BASES.some(basis => basis.toLowerCase() === keyword.toLowerCase()));
  if (basisTokens.length === 1) { source.level.basisKeyword = basisTokens[0]; source.level.basis = ORCA_BASES.find(basis => basis.toLowerCase() === basisTokens[0].toLowerCase()); }
  else if (basisTokens.length > 1) issue('orca-source-basis-conflict', '来源重复指定轨道基组，不能只取最后一项。', 'basis', basisTokens.join(' '), 'conflict');
  const method = methodMatches.length === 1 ? methodMatches[0].profile : undefined;
  if (method?.basisPolicy === 'uniform-def2' && !source.level.basis) issue('orca-source-basis-missing', '来源缺少可可靠恢复的统一轨道基组。', 'basis', undefined, 'missing');

  const dispersion = keywords.filter(keyword => /^(?:d3|d3zero|d3bj|d4)$/i.test(keyword));
  if (dispersion.length === 1) source.level.dispersion = /^d3(?:zero)?$/i.test(dispersion[0]) ? 'd3' : dispersion[0].toLowerCase() as 'd3bj' | 'd4';
  else if (dispersion.length > 1) { source.level.dispersion = null; issue('orca-source-dispersion-conflict', '来源重复指定色散，不能只取最后一项。', 'dispersion', dispersion.join(' '), 'conflict'); }
  else if (method && (method.family === 'composite' || /(?:-d3|-d4|-[vm])(?:\/\d+)?$/i.test(method.keywords[0]))) source.level.dispersion = 'builtin';
  const reference = keywords.filter(keyword => /^(?:uks|rks|uhf|rhf|roks|rohf)$/i.test(keyword));
  if (reference.length === 1 && !/^ro/i.test(reference[0])) source.level.unrestricted = /^u/i.test(reference[0]);
  else if (reference.length) issue('orca-source-reference', '来源参考波函数写法不能准确映射到当前R/U选项。', 'method', reference.join(' '), 'conflict');

  const solventValues: { model: 'cpcm' | 'smd'; name: string; raw: string }[] = [];
  for (const keyword of keywords) {
    if (methodMatches.some(match => match.keyword === keyword) || basisTokens.includes(keyword) || dispersion.includes(keyword) || reference.includes(keyword) || knownOther.test(keyword)) continue;
    if (/^def2\/j$/i.test(keyword) || ORCA_BASES.some(basis => keyword.toLowerCase() === (basis + '/C').toLowerCase())) continue;
    const solvent = keyword.match(/^(CPCM|SMD)\(([^()]*)\)$/i);
    if (solvent) { solventValues.push({ model: solvent[1].toLowerCase() as 'cpcm' | 'smd', name: solvent[2].trim().replace(/^"|"$/g, ''), raw: keyword }); continue; }
    if (/^(?:def2-ecp|def2-sd|noecp)$/i.test(keyword)) { source.level.ecpKeywords.push(keyword); if (!/^def2-ecp$/i.test(keyword)) issue('orca-source-ecp-variant', '来源ECP变体不能由当前统一def2写入器准确恢复。', 'ecp', keyword); continue; }
    if (/^(?:def2|ma-def2|\d+-\d|(?:aug-)?cc-p|ano|lanl|sto-|svp|tzvp)/i.test(keyword)) {
      source.level.basisKeyword ??= keyword; issue('orca-source-basis-unsupported', '已保留来源基组关键词，但当前产品不支持准确继承该基组。', 'basis', keyword); continue;
    }
    issue('orca-source-keyword', '未支持的来源简单关键词，未猜测其作用或替换为推荐值。', 'level', keyword);
  }
  for (const block of blocks(lines)) {
    if (!block.closed) { issue('orca-source-block-unclosed', '来源块未找到完整结束标记，保留原文且不声称完整继承。', block.name === 'geom' ? 'freeze' : ['basis','method','cpcm'].includes(block.name) ? 'level' : 'input', block.raw, 'missing'); continue; }
    if (['pal', 'maxcore', 'scf', 'output', 'base'].includes(block.name)) continue;
    if (['tddft','eprnmr','irc','neb','esd','md'].includes(block.name)) {
      issue('orca-source-task-block', '来源任务/性质块只保留证据，显式继承级别不带入这些任务选项。', 'task', block.raw, 'warning'); continue;
    }
    if (block.name === 'basis') {
      const ecp = [...block.body.matchAll(/(?:^|\n)\s*ECP\s+"([^"]+)"\s*(?=\n|end\b|$)/gi)];
      for (const match of ecp) source.level.ecpKeywords.push(match[1]);
      const rest = block.body.replace(/(?:^|\n)\s*ECP\s+"[^"]+"\s*(?=\n|end\b|$)/gi, '').replace(/\bend\b/gi, '').trim();
      if (rest || ecp.some(match => !/^def2-ecp$/i.test(match[1]))) {
        for (const match of block.body.matchAll(/\bNewECP\s+\S+\s+"([^"]+)"/gi)) source.level.ecpKeywords.push(match[1]);
        issue('orca-source-basis-block', '来源含分区/自定义基组或ECP设置；保留原文，不扁平化成统一def2基组。', 'basis', block.raw);
      }
      continue;
    }
    if (block.name === 'cpcm') {
      const smd = block.body.match(/\bsmd\s+true\b/i), name = block.body.match(/\bsmdsolvent\s+"([^"]+)"/i);
      const rest = block.body.replace(/\bsmd\s+true\b/i, '').replace(/\bsmdsolvent\s+"[^"]+"/i, '').replace(/\bend\b/gi, '').trim();
      if (smd && name && !rest) solventValues.push({ model: 'smd', name: name[1], raw: block.raw });
      else issue('orca-source-solvent-block', '来源溶剂块含自定义或未支持参数，不能仅凭名称完整继承。', 'solvent', block.raw);
      continue;
    }
    if (block.name === 'method') {
      const expected: Record<string, number> = { d3s6: .547, d3s8: 0, d3a1: 3.520, d3a2: 7.795 };
      const rows = block.body.replace(/\bend\b/gi, '').trim().split('\n').map(row => row.trim()).filter(Boolean);
      const mapped = rows.map(row => row.match(new RegExp(`^(d3s6|d3s8|d3a1|d3a2)\\s+(${number})$`, 'i')));
      if (!(source.level.method === 'wb97x-2-d3bj' && mapped.length === 4 && new Set(mapped.map(match => match?.[1].toLowerCase())).size === 4 && mapped.every(match => match && finite(match[2]) === expected[match[1].toLowerCase()])))
        issue('orca-source-method-block', '来源方法/色散参数块不能由当前方法预设准确恢复。', 'method', block.raw);
      continue;
    }
    if (block.name !== 'geom') { issue('orca-source-block', '保留未支持的来源块；不自动读取外部依赖或转换成当前级别。', ['moinp','pointcharges'].includes(block.name) ? 'files' : 'level', block.raw); continue; }
    const constraints = block.body.match(/\bconstraints\b([\s\S]*?)\bend\b/i)?.[1];
    const scan = block.body.match(/\bscan\b([\s\S]*?)\bend\b/i)?.[1];
    if (constraints) {
      const records = [...constraints.matchAll(/\{([^{}]*)\}/g)];
      const rest = constraints.replace(/\{[^{}]*\}/g, '').trim(); if (rest) issue('orca-source-constraint-record', '来源约束含未支持内容，保留原文。', 'freeze', rest);
      for (const record of records) {
        const row = record[1].trim(), raw = record[0];
        const cart = row.match(/^C\s+(\d+)(?::(\d+))?\s+C$/i);
        if (cart) {
          const first = Number(cart[1]), last = Number(cart[2] ?? cart[1]);
          if (![first,last].every(Number.isSafeInteger) || first > last || first < 0 || last >= atomCount) issue('orca-source-atom-freeze', '来源冻结原子越界或范围无效，未投影到其它原子。', 'freeze', raw, 'conflict');
          else for (let index = first; index <= last; index++) source.frozenAtoms.push(index + 1);
          continue;
        }
        const match = row.match(/^([BAD])\s+(.+?)\s+C$/i);
        if (!match) { issue('orca-source-constraint-unsupported', '来源约束未支持（如单轴、通配符或特殊中心），不转换成完整原子冻结。', 'freeze', raw); continue; }
        const type = match[1].toUpperCase() as OrcaSourceCoordinate['type'], count = type === 'B' ? 2 : type === 'A' ? 3 : 4;
        const fields = match[2].split(/\s+/), indices = fields.slice(0, count).map(Number);
        if (fields.slice(0, count).some(field => /[*:]/.test(field))) { issue('orca-source-constraint-unsupported', '来源内坐标通配符/集合约束未展开为普通冻结，保留原文。', 'freeze', raw); continue; }
        const value = fields[count] === undefined ? undefined : finite(fields[count]);
        if (fields.length < count || fields.length > count + 1 || !fields.slice(0, count).every(field => /^\d+$/.test(field)) || !indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < atomCount) || new Set(indices).size !== count || value !== undefined && (!new RegExp(`^${number}$`).test(fields[count]) || !Number.isFinite(value) || type === 'B' && value <= 0 || type === 'A' && (value <= 0 || value >= 180))) {
          issue('orca-source-coordinate-freeze', '来源内坐标冻结引用或目标值无效，未自动修补。', 'freeze', raw, 'conflict'); continue;
        }
        source.coordinates.push({ type, atoms: indices.map(index => index + 1), action: 'freeze', ...(value === undefined ? {} : { value }), raw });
        if (value !== undefined) issue('orca-freeze-target-value', '来源显式目标值冻结保留为证据；模型当前位置冻结不能表达该目标，未自动改写。', 'freeze', raw);
      }
    }
    if (scan) for (const raw of scan.split('\n').map(row => row.trim()).filter(Boolean)) {
      const match = raw.match(/^([BAD])\s+([\d\s]+?)\s*(?:=\s*(.+)|\[\s*(.+)\s*\])$/i);
      if (!match) { issue('orca-source-scan', '来源扫描写法未支持，保留原文，不生成扫描任务。', 'scan', raw); continue; }
      const type = match[1].toUpperCase() as OrcaSourceCoordinate['type'], count = type === 'B' ? 2 : type === 'A' ? 3 : 4, indices = match[2].trim().split(/\s+/).map(Number);
      const values = (match[3] ? match[3].split(',') : match[4].split(/\s+/)).map(value => finite(value.trim()));
      if (indices.length !== count || !indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < atomCount) || new Set(indices).size !== count || !values.every(Number.isFinite) || (match[3] ? values.length !== 3 || !Number.isSafeInteger(values[2]) || values[2] < 2 : values.length < 2)) {
        issue('orca-source-scan-reference', '来源扫描引用/范围信息不完整，未猜测观察对象。', 'scan', raw, 'conflict'); continue;
      }
      source.coordinates.push({ type, atoms: indices.map(index => index + 1), action: 'scan', raw });
    }
    const rest = block.body.replace(/\b(?:constraints|scan)\b[\s\S]*?\bend\b/gi, '').replace(/\bend\b/gi, '').trim();
    if (rest) {
      const inversion = /\binvertconstraints\s+true\b/i.test(rest);
      if (inversion) source.coordinates = source.coordinates.filter(row => row.action !== 'freeze');
      issue('orca-source-geom-options', inversion ? '来源反向内坐标约束不能作为普通冻结继承；完整Cartesian冻结不受该反向设置影响。' : '来源其它优化器设置保留为证据，不随级别/冻结继承。', inversion ? 'freeze' : 'task', rest, inversion ? 'unsupported' : 'warning');
    }
  }
  if (solventValues.length === 1) {
    const solvent = solventValues[0], entries = getSolventEntries('orca', solvent.model, 'common');
    if (entries.some(entry => (solvent.model === 'smd' ? entry.orca?.smd : entry.orca?.cpcm)?.toLowerCase() === solvent.name.toLowerCase())) source.level.solvent = solvent;
    else issue('orca-source-solvent-name', '来源溶剂没有已核实的原生内置关键词身份，未替换为目录近似项。', 'solvent', solvent.raw);
  } else if (solventValues.length > 1) issue('orca-source-solvent-conflict', '来源重复或冲突地指定溶剂模型，不取最后一项。', 'solvent', solventValues.map(value => value.raw).join('\n'), 'conflict');
  const coordinates: OrcaSourceCoordinate[] = [], seen = new Map<string, OrcaSourceCoordinate>(), blocked = new Set<string>();
  for (const row of source.coordinates) {
    const key = row.type + ':' + [row.atoms.join(','), [...row.atoms].reverse().join(',')].sort()[0];
    if (blocked.has(key)) continue;
    const previous = seen.get(key);
    if (previous) {
      if (previous.action === row.action && previous.value === row.value) continue;
      issue('orca-source-coordinate-conflict', '同一来源内坐标含冲突冻结/扫描定义，原文保留，不投影成当前位置冻结。', 'freeze', `${previous.raw}\n${row.raw}`, 'conflict');
      const index = coordinates.indexOf(previous); if (index >= 0) coordinates.splice(index, 1);
      seen.delete(key); blocked.add(key); continue;
    }
    coordinates.push(row); seen.set(key, row);
  }
  source.coordinates = coordinates;
  source.frozenAtoms = [...new Set(source.frozenAtoms)];
  source.unsupported = [...new Set(source.unsupported)];
  return source;
}
