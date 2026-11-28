'use strict';

const { createHash } = require('node:crypto');
const { failure, isRecord } = require('./wire.cjs');

const pubchem = 'https://pubchem.ncbi.nlm.nih.gov';
const cod = 'https://www.crystallography.net/cod/';
const codMirrors = [cod, 'https://cod.psdi.ac.uk/cod/', 'https://qiserver.ugr.es/cod/'];
const rcsb = 'https://www.rcsb.org';
const rcsbSearch = 'https://search.rcsb.org/rcsbsearch/v2/query';
const rcsbData = 'https://data.rcsb.org/rest/v1/core';
const pubchemId = /^[1-9][0-9]*$/;
const codId = /^[1-9][0-9]{6}$/;
const pdbId = /^[1-9][A-Za-z0-9]{3}$/;
const ligandId = /^[A-Za-z0-9]{1,5}$/;
const inchikey = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/;

function invalid(message) {
  throw failure('invalid_structure_source', message);
}

function record(database, recordId, recordType) {
  if (database === 'pubchem') return { database, recordId, url: `${pubchem}/compound/${recordId}` };
  if (database === 'cod') return { database, recordId, url: `${cod}${recordId}.html` };
  const route = recordType === 'ligand-ideal' ? 'ligand' : 'structure';
  return { database, recordId, recordType, url: `${rcsb}/${route}/${recordId}` };
}

function serverReplyError(url) {
  return failure('structure_source_response', '结构库未返回预期的数据，请用条目链接复核。', { url });
}

async function fetchData(url, { signal, fetchResponse }, request, parse, missing) {
  const deadline = AbortSignal.timeout(12000);
  const options = { signal: AbortSignal.any([signal, deadline]), redirect: 'error', credentials: 'omit', ...request };
  let response;
  try {
    response = await fetchResponse(url, options);
    if (missing?.includes(response.status)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw failure('structure_source_http', `结构库返回 HTTP ${response.status}。`, { url, httpStatus: response.status });
    }
    return await parse(response);
  } catch (error) {
    signal.throwIfAborted();
    if (typeof error.code === 'string' && error.code.startsWith('structure_source_')) throw error;
    if (error instanceof SyntaxError) throw serverReplyError(url);
    throw failure('structure_source_network', deadline.aborted ? '结构库连接或读取超时。' : '结构库连接失败。', { url, reason: error.cause?.code ?? error.message });
  }
}

async function tryCod(endpoint, signal, operation) {
  const attempts = [];
  let missingUrl;
  for (const origin of codMirrors) {
    signal.throwIfAborted();
    const url = new URL(endpoint, origin).href;
    try {
      const value = await operation(url);
      if (value !== null) return { value, url };
      missingUrl = url;
    } catch (error) {
      signal.throwIfAborted();
      attempts.push({ url, code: error.code, ...error.data });
    }
  }
  if (missingUrl) return { value: null, url: missingUrl };
  throw failure('structure_source_unavailable', 'COD 服务和镜像均未返回可用响应。', { attempts });
}

async function searchPubChem(query, queryType, limit, access) {
  const scope = queryType === 'auto' ? (pubchemId.test(query) ? 'id' : inchikey.test(query) ? 'inchikey' : 'name') : queryType;
  if (!['id', 'inchikey', 'name', 'smiles'].includes(scope)) invalid('PubChem 支持名称、CID、InChIKey 或 SMILES 检索。');
  if (scope === 'id' && !pubchemId.test(query) || scope === 'inchikey' && !inchikey.test(query)) invalid('PubChem CID 或 InChIKey 格式无效。');
  if (query === '.' || query === '..') invalid('PubChem 查询需要名称或有效结构标识。');
  const properties = '/property/Title,MolecularFormula/JSON';
  const base = `${pubchem}/rest/pug/compound/`;
  const url = scope === 'smiles' ? `${base}smiles${properties}` : `${base}${scope === 'id' ? 'cid' : scope}/${encodeURIComponent(query)}${properties}`;
  const request = scope === 'smiles' ? { method: 'POST', body: new URLSearchParams({ smiles: query }) } : {};
  const data = await fetchData(url, access, request, response => response.json(), [404]);
  const rows = data === null ? [] : data?.PropertyTable?.Properties;
  if (!Array.isArray(rows)) throw serverReplyError(url);
  const hits = rows.map(row => {
    const id = String(row.CID);
    if (!pubchemId.test(id)) throw serverReplyError(url);
    return { ...record('pubchem', id), title: row.Title, formula: row.MolecularFormula };
  });
  return { hits: hits.slice(0, limit), total: hits.length, queryUrl: url };
}

async function searchCod(query, queryType, limit, access) {
  const scope = queryType === 'auto' ? (codId.test(query) ? 'id' : /^(?:https:\/\/doi\.org\/)?10\.\d+\//i.test(query) ? 'doi' : 'name') : queryType;
  if (!['id', 'name', 'doi', 'formula'].includes(scope)) invalid('COD 支持条目号、名称、DOI 或 Hill 格式的化学式检索。');
  if (scope === 'id' && !codId.test(query)) invalid('COD 条目号须为七位数字。');
  // COD ID lookup uses the actual record file, including entries omitted from the default metadata index.
  if (scope === 'id') {
    const { value, url } = await tryCod(`${query}.cif`, access.signal, url => fetchData(url, access, { method: 'HEAD' }, () => true, [404]));
    return { hits: value === null ? [] : [record('cod', query)], total: value === null ? 0 : 1, queryUrl: url };
  }
  const parameter = scope === 'name' ? 'text' : scope;
  const value = scope === 'doi' ? query.replace(/^https:\/\/doi\.org\//i, '') : query;
  const params = new URLSearchParams({ format: 'json', [parameter]: value });
  const { value: rows, url } = await tryCod(`result?${params}`, access.signal, url => fetchData(url, access, {}, async response => {
    const data = await response.json();
    if (!Array.isArray(data)) throw serverReplyError(url);
    return data;
  }));
  const hits = rows.slice(0, limit).map(row => {
    const id = String(row.file);
    if (!codId.test(id)) throw serverReplyError(url);
    const revision = Number(row.svnrevision);
    return { ...record('cod', id), title: row.name || row.chemname || row.title || undefined,
      formula: typeof row.formula === 'string' ? row.formula.replace(/^\s*-\s*|\s*-\s*$/g, '') : undefined,
      spaceGroup: row.sg || undefined, doi: row.doi || undefined,
      ...(Number.isSafeInteger(revision) && revision > 0 ? { revision } : {}) };
  });
  return { hits, total: rows.length, queryUrl: url };
}

async function searchRcsb(query, queryType, recordType, limit, access) {
  const ligand = recordType === 'ligand-ideal';
  const scope = queryType === 'auto' ? ((ligand ? /^[A-Z0-9]{1,5}$/ : pdbId).test(query) ? 'id' : 'name') : queryType;
  if (!['id', 'name'].includes(scope)) invalid('RCSB 支持条目号、配体代码或文字检索。');
  if (scope === 'id') {
    if (!(ligand ? ligandId : pdbId).test(query)) invalid('RCSB 条目号或配体代码格式无效。');
    const id = query.toUpperCase();
    const url = `${rcsbData}/${ligand ? 'chemcomp' : 'entry'}/${id}`;
    const data = await fetchData(url, access, {}, response => response.json(), [404]);
    if (data === null) return { hits: [], total: 0, queryUrl: url };
    if ((ligand ? data?.chem_comp?.id : data?.entry?.id) !== id) throw serverReplyError(url);
    const hit = { ...record('rcsb', id, recordType), title: ligand ? data.chem_comp.name : data.struct?.title,
      ...(ligand ? { formula: data.chem_comp.formula } : data.pdbx_database_status?.pdb_format_compatible === 'N' ? { importable: false } : {}) };
    return { hits: [hit], total: 1, queryUrl: url };
  }
  const term = ligand ? { type: 'terminal', service: 'text_chem', parameters: { attribute: 'chem_comp.name', operator: 'contains_phrase', value: query } }
    : { type: 'terminal', service: 'full_text', parameters: { value: query } };
  const body = JSON.stringify({ query: term, return_type: ligand ? 'mol_definition' : 'entry', request_options: { paginate: { start: 0, rows: limit }, ...(ligand ? {} : { results_content_type: ['experimental'] }) } });
  const url = `${rcsbSearch}?${new URLSearchParams({ json: body })}`;
  const data = await fetchData(url, access, {}, response => response.json(), [204]);
  const rows = data === null ? [] : data?.result_set;
  if (!Array.isArray(rows)) throw serverReplyError(url);
  const hits = rows.map(row => {
    const identifier = row?.identifier;
    if (typeof identifier !== 'string' || !/^[A-Za-z0-9_]+$/.test(identifier)) throw serverReplyError(url);
    return { ...record('rcsb', identifier, recordType), ...((ligand ? ligandId : pdbId).test(identifier) ? {} : { importable: false }) };
  });
  return { hits, total: data?.total_count ?? hits.length, queryUrl: url };
}

async function download(args, access) {
  const { database } = args;
  let recordType, format, retrieval, retrievalUrl, bytes;
  const id = typeof args.recordId === 'string' ? args.recordId.trim().toUpperCase() : '';
  const revision = args.revision;
  if (database === 'pubchem') {
    if (!pubchemId.test(id)) invalid('请使用选定的 PubChem CID。');
    recordType = args.recordType ?? '3d';
    if (!['3d', '2d'].includes(recordType)) invalid('PubChem 可明确选择 3d 或 2d SDF。');
    format = 'sdf';
    retrieval = `${pubchem}/rest/pug/compound/cid/${id}/SDF?record_type=${recordType}`;
  } else if (database === 'cod') {
    if (!codId.test(id)) invalid('请使用选定的七位 COD 条目号。');
    format = 'cif';
    retrieval = `${id}.cif${revision ? `@${revision}` : ''}`;
  } else {
    recordType = args.recordType ?? 'entry';
    if (recordType === 'ligand-ideal' && ligandId.test(id)) {
      format = 'sdf';
      retrieval = `https://files.rcsb.org/ligands/download/${id}_ideal.sdf`;
    } else if (recordType === 'entry' && pdbId.test(id)) {
      format = 'pdb';
      retrieval = `https://files.rcsb.org/download/${id}.pdb`;
    } else invalid('请选择四字符的 RCSB 条目号，或明确用 ligand-ideal 和配体代码。');
  }
  const read = async response => {
    // Keep downloaded bytes unmodified for native import and project source retention.
    if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw serverReplyError(response.url);
    return new Uint8Array(await response.arrayBuffer());
  };
  if (database === 'cod') ({ value: bytes, url: retrievalUrl } = await tryCod(retrieval, access.signal, url => fetchData(url, access, {}, read, [404, 410])));
  else {
    retrievalUrl = retrieval;
    bytes = await fetchData(retrieval, access, {}, read, [404, 410]);
  }
  if (!bytes?.length) {
    const tip = database === 'pubchem' && recordType === '3d' ? '可核对 CID，或显式选择 2d 获取二维记录。'
      : database === 'rcsb' && recordType === 'entry' ? '该条目可能仅提供 PDBx/mmCIF。请查看条目页的原始格式。' : '请核对条目号和版本。';
    throw failure('structure_record_unavailable', `未取得所选结构记录。${tip}`, { ...record(database, id, recordType), ...(recordType ? { recordType } : {}), retrievalUrl });
  }
  const name = `${database}-${id}${recordType ? `-${recordType}` : ''}${revision ? `-r${revision}` : ''}.${format}`;
  const source = { ...record(database, id, recordType), format, ...(recordType ? { recordType } : {}),
    ...(revision ? { revision } : {}), retrievalUrl, retrievedAt: new Date().toISOString(), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  return { name, source, bytes };
}

/** Main process reconstructs every request from the active MCP call. */
async function structureSource(args, signal, fetchResponse = globalThis.fetch) {
  if (!isRecord(args) || !['pubchem', 'cod', 'rcsb'].includes(args.database)) invalid('请选择 PubChem、COD 或 RCSB。');
  signal.throwIfAborted();
  const access = { signal, fetchResponse };
  const { action, database, recordType, revision } = args;
  if (recordType !== undefined && !(database === 'pubchem' ? ['2d', '3d'] : database === 'rcsb' ? ['entry', 'ligand-ideal'] : []).includes(recordType)) invalid('所选数据库不使用这种记录类型。');
  if (action === 'import') {
    if (Object.keys(args).some(key => !['action', 'database', 'recordId', 'recordType', 'revision', 'show', 'presentation'].includes(key))) invalid('结构导入需要所选数据库及确切条目号。');
    if (revision !== undefined && !(database === 'cod' && Number.isSafeInteger(revision) && revision > 0)) invalid('仅 COD 支持显式传入正整数版本号。');
    return download(args, access);
  }
  if (action !== 'search' || typeof args.query !== 'string' || !args.query.trim() || args.query.includes('\0') ||
      Object.keys(args).some(key => !['action', 'database', 'query', 'queryType', 'recordType', 'limit'].includes(key))) invalid('结构库查询需要数据库及检索内容。');
  if (recordType !== undefined && database !== 'rcsb') invalid('仅 RCSB 查询可按条目或化学组分检索。');
  const query = args.query.trim(), queryType = args.queryType ?? 'auto', limit = args.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('候选返回数量须为 1 至 100。');
  const result = database === 'pubchem' ? await searchPubChem(query, queryType, limit, access) : database === 'cod' ?
    await searchCod(query, queryType, limit, access) : await searchRcsb(query, queryType, recordType ?? 'entry', limit, access);
  return { status: 'searched', database, query, ...result };
}

module.exports = { structureSource };
