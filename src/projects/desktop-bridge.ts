import { VibronicSha256 } from '../core/gaussian-vibronic/sha256-stream';

export type ProjectAssetCategory = 'models' | 'sources' | 'trajectories' | 'results';
export type ProjectOpaqueState = unknown;
const PROJECT_FORMAT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] as const;
export type ProjectFormatVersion = typeof PROJECT_FORMAT_VERSIONS[number];
export interface ProjectAsset { assetId: string; sha256: string; bytes: number; relativePath: string; category: ProjectAssetCategory; originalName?: string }
export interface ProjectManifest {
  schema: 'sciyue-project/v1'; formatVersion: ProjectFormatVersion; projectId: string; generation: number;
  appVersion: string; savedAt: string; kind: 'manual' | 'auto'; assets: Record<string, ProjectAsset>; assetIds: string[]; state: ProjectOpaqueState;
}
export interface ProjectSessionDescription {
  sessionId: string; projectId: string; indexPath: string; manifest: ProjectManifest | null; state: ProjectOpaqueState;
  recovery: { previous: ProjectManifest | null; auto: ProjectManifest | null };
  issues: Array<{ kind?: string; assetId?: string; code: string }>; recovered?: boolean; unchanged?: boolean;
  writeProtection?: { code: 'SY_SCHEMA_UNSUPPORTED'; points: ('auto' | 'previous')[] };
  readOnly?: true;
  openRequestId?: string;
}
type WithSession = { sessionId: string };
type WithTransaction = WithSession & { transactionId: string };
export interface ProjectAssetWrite { category:ProjectAssetCategory;name:string;bytes:Uint8Array|string }
export interface ProjectAssetUpload { uploadId:string;bytes:Uint8Array;category:ProjectAssetCategory;originalName?:string;expectedSha256?:string;expectedBytes?:number }
export interface WindowsAssociationStatus {
  supported: boolean; state: 'unsupported' | 'unregistered' | 'registered' | 'update-needed' | 'partial';
  executablePath: string; registeredExecutablePath?: string; extensions: string[]; ownedCount: number;
  requiresWindowsDefaultChoice: true; issues: Array<{ code: string; target: string; message: string }>;
  registered?: boolean; programId?: string;
  operation?: 'register' | 'remove'; changedCount?: number; retainedCount?: number;
}
export type SyProjectRequest =
  | { action: 'create'; name?: string; locationToken?: string }
  | { action: 'choose-location' }
  | { action: 'open-new' | 'claim' | 'associate' | 'association-status' | 'association-register' | 'association-remove' }
  | (WithSession & { action: 'begin'; kind?: 'manual' | 'auto'; state?: ProjectOpaqueState; assetIds?: string[] })
  | (WithTransaction & { action: 'chunk'; uploadId?: string; bytes: Uint8Array; final?: boolean; category?: ProjectAssetCategory; originalName?: string; expectedSha256?: string; expectedBytes?: number })
  | (WithTransaction & { action:'assets';assets:ProjectAssetUpload[] })
  | (WithTransaction & { action: 'commit'; state?: ProjectOpaqueState; assetIds?: string[]; requiredFormatVersion?: ProjectFormatVersion })
  | (WithTransaction & { action: 'abort' })
  | (WithSession & { action: 'read'; assetId: string; offset?: number; length?: number })
  | (WithSession & {action:'read-assets';assetIds:string[]})
  | (WithSession & { action: 'settle-open'; openRequestId: string; status: 'loaded' | 'failed'; message?: string })
  | (WithSession & { action: 'close' | 'gc' | 'read-saved' });
export interface SyProjectActionValues {
  'choose-location': { locationToken: string; label: string } | { cancelled: true };
  create: ProjectSessionDescription | { cancelled: true };
  'open-new': { opened: true; windowId: number } | { cancelled: true };
  claim: ProjectSessionDescription | { pending: false } | { cancelled: true };
  associate: WindowsAssociationStatus;
  'association-status': WindowsAssociationStatus;
  'association-register': WindowsAssociationStatus;
  'association-remove': WindowsAssociationStatus;
  begin: { transactionId: string };
  chunk: { uploadId: string; bytes?: number; asset?: ProjectAsset };
  assets:{receipts:{uploadId:string;asset:ProjectAsset}[]};
  commit: ProjectSessionDescription;
  abort: { aborted: true };
  read: { bytes: Uint8Array; eof: boolean; totalBytes: number };
  'read-assets':{assets:{assetId:string;bytes:Uint8Array;asset:ProjectAsset}[]};
  'settle-open': { accepted: true };
  close: { closed: true };
  'read-saved': ProjectSessionDescription;
  gc: { deleted: Array<{ assetId: string; bytes: number }>; skipped: string | Array<{ assetId: string; reason: string }> };
}
export type SyProjectResponse<T = SyProjectActionValues[keyof SyProjectActionValues]> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type SyProjectInvoke = (request: SyProjectRequest) => Promise<SyProjectResponse>;
export interface SyProjectDesktopBridge { syProject: SyProjectInvoke }
export const PROJECT_CHUNK_BYTES = 1024 * 1024;
export const PROJECT_ASSET_BATCH_COUNT=32;
/** A new destination must retain the compatibility floor of its source project. */
export function projectFormatFloor(...versions:readonly unknown[]):ProjectFormatVersion {
  const present=versions.filter(version=>version!==undefined);
  if(present.some(version=>!PROJECT_FORMAT_VERSIONS.includes(version as ProjectFormatVersion)))throw Object.assign(new Error('项目保存格式要求不受支持，未覆盖原项目。'),{code:'SY_SCHEMA_UNSUPPORTED'});
  return Math.max(1,...present as number[]) as ProjectFormatVersion;
}
export function projectSaveFormatVersion(state:unknown, prior:ProjectFormatVersion=1):ProjectFormatVersion {
  const declared=state&&typeof state==='object'?(state as {requiredProjectFormatVersion?:unknown}).requiredProjectFormatVersion:undefined;
  return projectFormatFloor(prior,declared);
}
export async function invokeProject<A extends SyProjectRequest['action']>(invoke: SyProjectInvoke, request: Extract<SyProjectRequest, { action: A }> | (SyProjectRequest & { action: A })): Promise<SyProjectActionValues[A]> {
  const response = await invoke(request);
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  return response.value as SyProjectActionValues[A];
}
export interface ProjectAssetRange {
  bytes: number;
  sha256: string;
  readRange(offset: number, length: number): Promise<Uint8Array>;
}
export interface ProjectAssetWriter {
  write(category: ProjectAssetCategory, name: string, bytes: Uint8Array | string): Promise<{ assetId: string }>;
  writeRange?(category: ProjectAssetCategory, name: string, source: ProjectAssetRange): Promise<{ assetId: string }>;
  writeMany?(values:readonly ProjectAssetWrite[]):Promise<{assetId:string}[]>;
  assetIds(): string[];
  forEachAsset(callback: (assetId: string) => void): void;
  retainAsset(assetId: string): void;
  hasAsset?(assetId: string): boolean;
}
export interface ProjectAssetReader { read(assetId: string): Promise<Uint8Array>;readMany?(assetIds:readonly string[]):Promise<Uint8Array[]>; readRange?(assetId: string, offset: number, length: number, expectedBytes: number): Promise<Uint8Array> }
export async function projectAssetSha256(bytes:Uint8Array):Promise<string>{
  if(bytes.length>PROJECT_CHUNK_BYTES){
    const hash=new VibronicSha256();let lastYield=performance.now();
    for(let offset=0;offset<bytes.length;offset+=PROJECT_CHUNK_BYTES){
      hash.update(bytes.subarray(offset,offset+PROJECT_CHUNK_BYTES));
      if(performance.now()-lastYield>=10){await new Promise<void>(resolve=>setTimeout(resolve,0));lastYield=performance.now();}
    }
    return hash.digest();
  }
  const input=bytes.buffer instanceof ArrayBuffer?bytes as Uint8Array<ArrayBuffer>:bytes.slice();
  const digest=await crypto.subtle.digest('SHA-256',input);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
export function createProjectAssetIO(sessionId: string, transactionId: string, invoke: SyProjectInvoke, initialAssetIds: Iterable<string> = [], reusableAssetIds: Iterable<string> = []): { writer: ProjectAssetWriter; reader: ProjectAssetReader; assetIds: () => string[]; forEachAsset: (callback: (assetId: string) => void) => void; retainAsset: (assetId: string) => void } {
  const assets = new Set<string>(initialAssetIds); let nextUpload = 0;
  const reusable = new Set(reusableAssetIds);
  const assetIds = () => [...assets];
  const forEachAsset = (callback: (assetId: string) => void) => assets.forEach(callback);
  const retainAsset = (assetId: string) => { assets.add(assetId); };
  async function writeRange(category: ProjectAssetCategory, name: string, source: ProjectAssetRange) {
    const { bytes, sha256 } = source;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('Project asset range identity is invalid.');
    if (reusable.has(sha256)) { assets.add(sha256); return { assetId: sha256 }; }
    const uploadId = `asset-${Date.now()}-${nextUpload++}`;
    for (let offset = 0; offset < bytes || offset === 0; offset += PROJECT_CHUNK_BYTES) {
      const length = Math.min(bytes - offset, PROJECT_CHUNK_BYTES), final = offset + length === bytes;
      const range = length ? await source.readRange(offset, length) : new Uint8Array();
      if (range.byteLength !== length) throw Error('Project asset range was incomplete.');
      const page = range.byteOffset === 0 && range.byteLength === range.buffer.byteLength && range.buffer instanceof ArrayBuffer ? range : range.slice();
      const { asset } = await invokeProject(invoke, { action: 'chunk', sessionId, transactionId, uploadId, category, originalName: name, expectedSha256: sha256, expectedBytes: bytes, bytes: page, final });
      if (final) {
        if (asset?.assetId !== sha256 || asset.sha256 !== sha256 || asset.bytes !== bytes) throw Error('Project asset receipt did not match the uploaded identity.');
        reusable.add(sha256); assets.add(sha256); return { assetId: sha256 };
      }
    }
    throw new Error('Project asset upload did not complete.');
  }
  const writer: ProjectAssetWriter = {
    async write(category, name, supplied) {
      const bytes = typeof supplied === 'string' ? new TextEncoder().encode(supplied) : supplied;
      const sha256 = await projectAssetSha256(bytes);
      return writeRange(category, name, { bytes: bytes.byteLength, sha256, async readRange(offset, length) {
        return bytes.byteOffset === 0 && offset === 0 && length === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
          ? bytes : bytes.slice(offset, offset + length);
      } });
    },
    writeRange,
    async writeMany(values){
      const output:{assetId:string}[]=[];
      let batch:{category:ProjectAssetCategory;name:string;bytes:Uint8Array}[]=[],batchBytes=0;
      const flush=async()=>{
        if(!batch.length)return;
        const current=batch;batch=[];batchBytes=0;
        const hashes=await Promise.all(current.map(value=>projectAssetSha256(value.bytes))),uploads:ProjectAssetUpload[]=[],seen=new Set<string>();
        current.forEach((value,index)=>{const sha256=hashes[index];if(reusable.has(sha256)||seen.has(sha256))return;seen.add(sha256);uploads.push({uploadId:`asset-${Date.now()}-${nextUpload++}`,category:value.category,originalName:value.name,bytes:value.bytes,expectedBytes:value.bytes.byteLength,expectedSha256:sha256});});
        if(uploads.length){
          const {receipts}=await invokeProject(invoke,{action:'assets',sessionId,transactionId,assets:uploads});
          if(!Array.isArray(receipts)||receipts.length!==uploads.length||receipts.some((receipt,index)=>{const expected=uploads[index];return receipt.uploadId!==expected.uploadId||receipt.asset?.assetId!==expected.expectedSha256||receipt.asset.sha256!==expected.expectedSha256||receipt.asset.bytes!==expected.expectedBytes;}))throw new Error('Project batch asset receipts did not match uploaded bytes or order.');
          // A failed or malformed group cannot publish partially trusted refs.
          for(const receipt of receipts)reusable.add(receipt.asset.assetId);
        }
        for(const assetId of hashes){assets.add(assetId);output.push({assetId});}
      };
      for(const value of values){
        const bytes=typeof value.bytes==='string'?new TextEncoder().encode(value.bytes):value.bytes;
        if(bytes.byteLength>PROJECT_CHUNK_BYTES){await flush();output.push(await writer.write(value.category,value.name,bytes));continue;}
        if(batch.length===PROJECT_ASSET_BATCH_COUNT||batchBytes+bytes.byteLength>PROJECT_CHUNK_BYTES)await flush();
        const page=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength&&bytes.buffer instanceof ArrayBuffer?bytes:bytes.slice();
        batch.push({...value,bytes:page});batchBytes+=bytes.byteLength;
      }
      await flush();return output;
    }, assetIds, forEachAsset, retainAsset, hasAsset: assetId=>reusable.has(assetId),
  };
  const reader: ProjectAssetReader = {
    async readRange(assetId, offset, length, expectedBytes) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || length > PROJECT_CHUNK_BYTES
        || !Number.isSafeInteger(expectedBytes) || length > expectedBytes - offset) throw Error('Project asset range is invalid.');
      const result = await invokeProject(invoke, { action: 'read', sessionId, assetId, offset, length });
      const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
      if (result.totalBytes !== expectedBytes || bytes.byteLength !== length || Boolean(result.eof) !== (offset + length === expectedBytes)) throw Error('Project asset page size changed while reading.');
      assets.add(assetId);
      return bytes;
    },
    async readMany(assetIds){
      if(assetIds.length>PROJECT_ASSET_BATCH_COUNT)throw Error('Project asset read batch exceeds its bounded count.');
      if(!assetIds.length)return[];
      const reply=await invokeProject(invoke,{action:'read-assets',sessionId,assetIds:[...assetIds]});
      if(!Array.isArray(reply.assets)||reply.assets.length!==assetIds.length)throw Error('Project read batch receipts are incomplete.');
      const values:Uint8Array[]=[];let total=0;
      for(let index=0;index<assetIds.length;index++){const part=reply.assets[index],bytes=part.bytes instanceof Uint8Array?part.bytes:new Uint8Array(part.bytes);total+=bytes.length;
        if(part.assetId!==assetIds[index]||part.asset?.assetId!==part.assetId||part.asset.sha256!==part.assetId||part.asset.bytes!==bytes.length||total>PROJECT_CHUNK_BYTES||await projectAssetSha256(bytes)!==part.assetId)throw Error('Project read batch bytes or identity did not match.');values.push(bytes);
      }
      for(const id of assetIds)assets.add(id);return values;
    },
    async read(assetId) {
      let output: Uint8Array | undefined, offset = 0;
      for (;;) {
        const result = await invokeProject(invoke, { action: 'read', sessionId, assetId, offset, length: PROJECT_CHUNK_BYTES });
        const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
        if (!Number.isSafeInteger(result.totalBytes) || result.totalBytes < 0 || (output && output.byteLength !== result.totalBytes)) throw new Error('Project asset size changed while reading.');
        output ??= new Uint8Array(result.totalBytes);
        if (bytes.byteLength > PROJECT_CHUNK_BYTES || offset + bytes.byteLength > output.byteLength) throw new Error('Invalid project asset chunk.');
        output.set(bytes, offset); offset += bytes.byteLength;
        if (result.eof) { if (offset !== output.byteLength) throw new Error('Project asset is truncated.'); assets.add(assetId); return output; }
        if (!bytes.byteLength) throw new Error('Project asset read made no progress.');
      }
    },
  };
  return { writer, reader, assetIds, forEachAsset, retainAsset };
}
