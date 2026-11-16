import type { XtbElectronicArtifactBundle } from '../../modeling/xtb/contracts';
import { validateGeneratedXtbBundle, type GeneratedXtbSourcePackage } from '../../results/xtb-generated-source';
import { isGeneratedXtbAnalysisPolicy } from '../../results/generated-xtb-policy';
import type { SnapshotProjectSources } from './snapshot-project';
import { VibronicSha256 } from '../../core/gaussian-vibronic/sha256-stream';

/** Reconstruct an archived, exact-role XTB native package. No scientific
 * command is launched and the historical native session is never resumed. */
export async function readSnapshotGeneratedXtbPackage(bundle: SnapshotProjectSources): Promise<GeneratedXtbSourcePackage | undefined> {
 const metadata = bundle.description.files.filter(file => file.format === 'ester-gfn2-provenance'||file.format==='ester-gxtb-provenance'); if (!metadata.length) return undefined; if (metadata.length !== 1) throw Error('XTB来源包身份不唯一。');
 const provenanceFile = bundle.files.find(file => file.snapshotIdentity.sourceRef === metadata[0].sourceRef); if (!provenanceFile) throw Error('GFN2原始来源包不可取得。');
 const value = JSON.parse(await provenanceFile.text()) as { schema: string; metadata: Omit<XtbElectronicArtifactBundle, 'files'>; expected: GeneratedXtbSourcePackage['expected']; analysisPolicy?: GeneratedXtbSourcePackage['analysisPolicy']; files: Omit<XtbElectronicArtifactBundle['files'][number], 'text'>[] };
 const producer=metadata[0].format==='ester-gxtb-provenance'?'gxtb':'gfn2';
 if (value.schema !== `ester-${producer}-source-package/v1` || value.metadata?.metadata?.method!==producer || !Array.isArray(value.files)) throw Error('XTB原始来源包格式或计算级别不一致。');
 const files: XtbElectronicArtifactBundle['files'] = [];
 for (const expected of value.files) {
  const candidates = bundle.description.files.filter(file => file.name === expected.name && file.sha256 === expected.sha256 && file.byteSize === expected.bytes);
  if (candidates.length !== 1) throw Error(`GFN2必要来源 ${expected.name} 缺失或身份不唯一。`);
  const file = bundle.files.find(file => file.snapshotIdentity.sourceRef === candidates[0].sourceRef); if (!file) throw Error('GFN2原始文件不可取得。');
  const text = await file.text(), bytes = new TextEncoder().encode(text), hash = new VibronicSha256(); hash.update(bytes);
  if (bytes.length !== expected.bytes || hash.digest() !== expected.sha256) throw Error('GFN2原始字节与保存来源不一致。'); files.push({ ...expected, text });
 }
 const saved = { schema: 1 as const, bundle: { ...value.metadata, files }, expected: value.expected, ...(value.analysisPolicy ? { analysisPolicy: value.analysisPolicy } : {}) };
 const { analysisMolden } = await validateGeneratedXtbBundle(saved.bundle, saved.expected);
 const revision = analysisMolden.sha256;
 if (saved.analysisPolicy && !isGeneratedXtbAnalysisPolicy(saved.analysisPolicy, revision)) throw Error('GFN2保存的分析能力与原波函数不一致。');
 return saved;
}
