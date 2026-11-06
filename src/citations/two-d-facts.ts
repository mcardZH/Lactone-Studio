import { readImportedModelSourceManifests } from '../projects/import-sources';
import type { CitationFact } from './types';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SMALL_ASSET_BYTES = 1024 ** 2;
const MAX_CHECKED_BYTES = 4 * 1024 ** 2;
type JSONRecord = Record<string, unknown>;
const record = (value: unknown): value is JSONRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const safeName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && !value.includes('..');
async function digest(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join(''); }
const knownEngines: Record<string, string> = { ketcher: 'Ketcher', indigo: 'Indigo', molvec: 'MolVec', molscribe: 'MolScribe', rdkit: 'RDKit' };

/** Only committed import bundles are consulted. This neither opens image data
 * nor invokes an editor, recognizer, calculator, network, or project write. */
export async function readCommittedTwoDCitationFacts(documentIds: readonly string[]): Promise<{ facts: CitationFact[]; warnings: string[] }> {
  const facts: CitationFact[] = [], warnings: string[] = [];
  const handles = readImportedModelSourceManifests(documentIds, '2d-provenance.json', MAX_MANIFEST_BYTES);
  for (const handle of handles) {
    try {
      const bytes = await handle.readSource(handle.manifest.sourceId);
      const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!record(manifest) || manifest.schema !== 'ester-two-d-provenance' || manifest.version !== 1) throw new Error('不支持或缺少二维来源schema/version');
      if (!record(manifest.source) || !text(manifest.source.id) || !['cdx', 'cdxml', 'mol', 'ket'].includes(String(manifest.source.format))
        || !['draw', 'file-import', 'image-recognition'].includes(String(manifest.source.sourceKind)) || manifest.source.payloadRole !== 'original'
        || !text(manifest.selectedComponentId) || typeof manifest.edited !== 'boolean' || !Array.isArray(manifest.artifacts)
        || !record(manifest.relationships) || !Array.isArray(manifest.atomMapping) || !manifest.atomMapping.length) throw new Error('二维提交来源、组分或关系不完整');
      const roles = new Map<string, JSONRecord>(), names = new Set<string>();
      if (handle.sources.filter(source => source.name === '2d-provenance.json').length !== 1) throw new Error('同一来源bundle存在多个二维manifest');
      const primaryNames: Record<string, string> = { original: `original.${manifest.source.format}`, 'initial-ket': 'initial.ket', 'final-ket': 'final.ket', 'final-graph': 'final-2d.json' };
      let checkedBytes = 0;
      for (const item of manifest.artifacts) {
        if (!record(item) || !safeName(item.role) || !safeName(item.name) || !sha(item.sha256) || !Number.isSafeInteger(item.size) || Number(item.size) < 0 || !text(item.mime)
          || roles.has(item.role.toLowerCase()) || names.has(item.name.toLowerCase()) || item.name.toLowerCase() === '2d-provenance.json') throw new Error('二维artifact角色、摘要或大小无效');
        if (primaryNames[item.role] && (item.name !== primaryNames[item.role] || ['initial-ket', 'final-ket', 'final-graph'].includes(item.role) && item.mime !== 'application/json')) throw new Error('二维主要资产角色与名称或类型不一致');
        const members = handle.sources.filter(source => source.name === item.name && source.size === item.size);
        if (members.length !== 1) throw new Error('二维artifact未对应同一文档bundle内的唯一来源');
        roles.set(item.role.toLowerCase(), item); names.add(item.name.toLowerCase());
        // Images are retained evidence, not citation payloads. Their declared
        // digest is preserved in the hashed manifest; never load them here.
        if (!item.mime.startsWith('image/') && !/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(item.name)) {
          if (Number(item.size) > MAX_SMALL_ASSET_BYTES) {
            if (['final-ket', 'final-graph'].includes(item.role)) throw new Error('二维最终提交资产超过有界校验上限');
            continue; // Large original/raw assets remain bound by manifest identity and bundle size.
          }
          if (checkedBytes + Number(item.size) > MAX_CHECKED_BYTES) throw new Error('二维小资产总量超过有界校验上限');
          const payload = await handle.readSource(members[0].sourceId, MAX_SMALL_ASSET_BYTES);
          checkedBytes += payload.byteLength;
          if (await digest(payload) !== item.sha256.toLowerCase()) throw new Error('二维来源artifact摘要不匹配');
        }
      }
      for (const [key, role] of Object.entries({ originalRole: 'original', initialKetRole: 'initial-ket', finalKetRole: 'final-ket', finalGraphRole: 'final-graph' })) {
        if (manifest.relationships[key] !== role || !roles.has(role) || !Number(roles.get(role)!.size)) throw new Error('二维最终提交资产关系缺失');
      }
      const engines: [string, unknown][] = [];
      if (manifest.engines !== undefined && !record(manifest.engines)) throw new Error('二维处理引擎记录无效');
      if (record(manifest.engines)) for (const stage of ['editor', 'parser', 'generator']) if (manifest.engines[stage] !== undefined) engines.push([stage, manifest.engines[stage]]);
      if (manifest.recognition !== undefined) {
        const recognition = manifest.recognition;
        if (!record(recognition) || manifest.source.sourceKind !== 'image-recognition') throw new Error('图片识别来源记录冲突');
        const imageRoles = manifest.relationships.recognitionImageRoles;
        if (!Array.isArray(imageRoles) || !imageRoles.length || imageRoles.some(role => !text(role) || !roles.get(role.toLowerCase())?.mime || !Number(roles.get(role.toLowerCase())!.size) || !String(roles.get(role.toLowerCase())!.mime).startsWith('image/'))) throw new Error('图片识别输入未对应留存图像资产');
        for (const key of ['originalImageRole', 'inputImageRole']) if (recognition[key] !== undefined && (!text(recognition[key]) || !imageRoles.includes(recognition[key]))) throw new Error('图片识别图像角色未对应留存资产');
        if (recognition.rawCandidateRoles !== undefined && (!Array.isArray(recognition.rawCandidateRoles) || recognition.rawCandidateRoles.some(role => !text(role) || !roles.has(role.toLowerCase())))) throw new Error('图片识别候选未对应留存资产');
        engines.push(['recognition', recognition]);
      } else if (manifest.source.sourceKind === 'image-recognition') throw new Error('图片识别来源缺少实际识别记录');
      const manifestSHA256 = await digest(bytes), pending: CitationFact[] = [];
      for (const [stage, value] of engines) {
        if (!record(value) || !text(value.engine) || !text(value.version) || value.method !== undefined && !text(value.method)) throw new Error('二维处理引擎缺少真实身份或版本');
        const software = knownEngines[value.engine.toLowerCase()];
        if (!software) { warnings.push(`二维来源${handle.bundleId}的${stage}引擎尚未审核：${value.engine}`); continue; }
        for (const documentId of handle.documentIds) {
          const base = { id: `two-d:${handle.bundleId}:${manifestSHA256}:${stage}`, documentId, sourceId: handle.manifest.sourceId,
            kind: 'model-operation' as const, retained: true, stage, software, version: value.version,
            parameters: { provenanceSHA256: manifestSHA256, sourceIdentity: manifest.source.id, componentId: manifest.selectedComponentId },
            evidence: [{ kind: 'source' as const, locator: `import-bundle:${handle.bundleId}/${handle.manifest.sourceId}`, detail: `ester-two-d-provenance@1 SHA256:${manifestSHA256}; stage:${stage}; artifacts:role/size/SHA256; images:manifest-bound metadata` }],
            purpose: stage === 'recognition' ? '保留模型的二维图片结构识别' : stage === 'generator' ? '保留二维结构的三维坐标生成' : stage === 'parser' ? '保留模型的二维结构解析' : '保留模型的二维结构编辑' };
          pending.push(software === 'RDKit' ? { ...base, feature: 'software', method: 'RDKit' }
            : { ...base, feature: 'two-d-software', method: `${software}@${value.version}` });
          if (stage === 'generator' && software === 'RDKit' && value.method === 'ETKDGv3') pending.push({ ...base, id: `${base.id}:etkdgv3`, feature: 'method', method: 'etkdgv3' });
        }
      }
      if (!handle.isCurrent()) throw new Error('二维来源owner或文档归属已变化');
      facts.push(...pending);
    } catch (error) { warnings.push(`二维来源${handle.bundleId}未收集引用：${error instanceof Error ? error.message : String(error)}`); }
  }
  return { facts, warnings };
}
