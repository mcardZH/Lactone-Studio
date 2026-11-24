import { VibronicSha256 } from '../../core/gaussian-vibronic/sha256-stream';
import type { AnalysisOriginalCubeSource } from '../../projects/analysis-state';
import { assertResultNotAborted } from '../../results/contracts';
import type { CubeAtom, SurfaceGrid, SurfaceValidDomain } from '../../results/surface-contracts';
import { CUBE_PAGE_BYTES } from './cube-display-reader';
import type { CubeAssetDesktop } from './cube-asset-bridge';
import { exportBlob } from './export-image';

export type ScientificGrid = { grid: SurfaceGrid; atoms: readonly CubeAtom[]; values: Float64Array; valueUnit: string | null; validDomain: SurfaceValidDomain; source?: { datasetId?: number } };
type CubeExportDesktop = CubeAssetDesktop & { saveOwnedSurfaceCube?(request: { name: string; assetId: string; domainAssetId?: string }): Promise<{ cancelled: boolean }> };
const utf8 = new TextEncoder();
function textNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Cube 包含无效坐标或格点值。');
  return Object.is(value, -0) ? '-0.0000000000000000e+0' : value.toExponential(16);
}

export function* savedCubeText(field: ScientificGrid, title: string): Generator<string> {
  const { grid, atoms, values, validDomain } = field;
  if (grid.ordering !== 'z-fastest' || !atoms.length || !grid.dimensions.every(value => Number.isSafeInteger(value) && value > 0)
    || values.length !== grid.dimensions.reduce((a, b) => a * b, 1)) throw new Error('保存格点的尺寸或排序无效，不能导出 Cube。');
  const datasetId = field.source?.datasetId;
  if (datasetId !== undefined && !Number.isSafeInteger(datasetId)) throw new Error('Cube 数据集身份无效。');
  const titleText=title.replace(/[\r\n]/g, ' ') + (validDomain.kind==='full-grid'?'':' (restricted-domain; requires bound domain metadata)');
  yield `${titleText}\nvalueUnit=${field.valueUnit ?? 'unknown'}; validDomain=${validDomain.kind}; see .sciyue-domain.json\n`;
  yield `${datasetId === undefined ? atoms.length : -atoms.length} ${grid.origin.map(textNumber).join(' ')}\n`;
  for (const [index, axis] of grid.axes.entries()) yield `${grid.coordinateUnit === 'angstrom' ? -grid.dimensions[index] : grid.dimensions[index]} ${axis.map(textNumber).join(' ')}\n`;
  for (const atom of atoms) yield `${atom.atomicNumber} ${textNumber(atom.nuclearCharge)} ${atom.position.map(textNumber).join(' ')}\n`;
  if (datasetId !== undefined) yield `1 ${datasetId}\n`;
  const nz = grid.dimensions[2];
  for (let column = 0; column < values.length; column += nz) {
    for (let row = 0; row < nz; row += 6) {
      let line=''; for(let index = column+row, end=column+Math.min(row+6,nz);index<end;index++) line+=(line?' ':'')+textNumber(values[index]);
      yield line+'\n';
    }
  }
}

export function* savedCubeDomainText(field: ScientificGrid, revision: string): Generator<string> {
  const { values: _values, validDomain, grid, ...metadata } = field;
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Cube 有效域需要确切的文件内容身份。');
  yield `{"schema":"sciyue-surface-domain/v1","sourceRevision":${JSON.stringify(revision)},"coordinateUnit":${JSON.stringify(grid.coordinateUnit)},"grid":${JSON.stringify(grid)}`;
  for (const [key,value] of Object.entries(metadata)) {
    if (key==='schema'||key==='sourceRevision'||key==='coordinateUnit'||value===undefined) continue;
    if (key==='atoms') {
      yield ',"atoms":[';
      for(let index=0;index<field.atoms.length;index++) yield (index?',':'')+JSON.stringify(field.atoms[index]);
      yield ']';
    } else yield ','+JSON.stringify(key)+':'+JSON.stringify(value);
  }
  if (validDomain.kind !== 'node-mask') { yield `,"validDomain":${JSON.stringify(validDomain)}}`; return; }
  const { mask, ...definition } = validDomain;
  if (mask.length !== field.values.length) throw new Error('Cube 有效域和格点的节点数不一致。');
  yield ',"validDomain":'+JSON.stringify(definition).slice(0,-1)+',"maskBase64":"';
  // Every nonterminal page is a multiple of three so base64 can be joined as a stream.
  for(let start=0;start<mask.length;start+=24576) {
    const page=mask.subarray(start,start+24576);
    if (!page.every(value=>value===0||value===1)) throw new Error('Cube 有效域含无效节点标记。');
    yield btoa(String.fromCharCode(...page));
  }
  yield '"}}';
}

async function* encodedPages(rows: Iterable<string>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  let pending='', lastYield=performance.now();
  for (const row of rows) {
    pending+=row;
    if(pending.length<16384) continue;
    assertResultNotAborted(signal);
    const bytes=utf8.encode(pending);
    for(let offset=0;offset<bytes.length;offset+=CUBE_PAGE_BYTES) yield bytes.slice(offset,offset+CUBE_PAGE_BYTES);
    pending='';
    if(performance.now()-lastYield>=10) { await new Promise<void>(resolve=>setTimeout(resolve,0)); lastYield=performance.now(); }
  }
  assertResultNotAborted(signal);
  if(pending) yield utf8.encode(pending);
}

async function* originalPages(source: AnalysisOriginalCubeSource, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  for(let offset=0;offset<source.bytes;offset+=CUBE_PAGE_BYTES){
    assertResultNotAborted(signal);
    const length=Math.min(CUBE_PAGE_BYTES,source.bytes-offset),page=await source.readRange(offset,length);
    if(page.byteLength!==length)throw new Error('Cube 原件分页长度与来源不符。');
    yield page.byteOffset===0&&page.byteLength===page.buffer.byteLength?page:page.slice();
  }
}

async function download(pages: AsyncGenerator<Uint8Array>, mediaType: string, hash?: VibronicSha256) {
  const body=new ReadableStream<Uint8Array<ArrayBuffer>>({ async pull(controller) {
    const next=await pages.next(); if(next.done){controller.close();return;}
    hash?.update(next.value);controller.enqueue(next.value as Uint8Array<ArrayBuffer>);
  }, async cancel(){await pages.return(undefined);} });
  return new Response(body,{headers:{'Content-Type':mediaType}}).blob();
}

interface StagedGridFile {id:string;size:number;sha256:string}
function createAnalysisExportStaging(desktop:CubeAssetDesktop,signal?:AbortSignal) {
  const {beginBinaryAsset:begin,appendBinaryAsset:append,sealBinaryAsset:seal,releaseBinaryAsset:release}=desktop;
  if(!begin||!append||!seal||!release)throw new Error('当前环境没有可分段暂存的科学格点导出入口。');
  const ids:string[]=[];
  async function dispose(){
    const settled=await Promise.allSettled(ids.map(async id=>release!(id)));
    return settled.flatMap((result,index)=>result.status==='rejected'?[{
      code:'export_staging_release_failed',assetId:ids[index],message:result.reason instanceof Error?result.reason.message:String(result.reason),
    }]:[]);
  }
  async function stage(pages:AsyncIterable<Uint8Array>,bytes?:number):Promise<StagedGridFile>{
    assertResultNotAborted(signal);
    const {id}=await begin!(bytes);ids.push(id);let size=0;
    for await(const page of pages){
      assertResultNotAborted(signal);size+=page.byteLength;
      if((await append!(id,page)).size!==size)throw new Error('Cube 保存暂存长度不一致。');
    }
    const result=await seal!(id);
    if(result.size!==size||!result.sha256)throw new Error('Cube 保存缺少确切文件身份。');
    return {id,size,sha256:result.sha256};
  }
  return {stage,dispose};
}

export async function stageScientificText(text:string,desktop:CubeAssetDesktop,signal?:AbortSignal){
  const {stage,dispose}=createAnalysisExportStaging(desktop,signal);
  try{
    // Provide bounded pages even when one scientific row has no newline.
    function* slices(){for(let offset=0;offset<text.length;){let end=Math.min(text.length,offset+16384);
      if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;
      yield text.slice(offset,end);offset=end;}}
    const file=await stage(encodedPages(slices(),signal));
    return {file,dispose};
  }catch(error){await dispose();throw error;}
}

export async function stageSavedCube(field:ScientificGrid,desktop:CubeAssetDesktop,options:{title:string;signal?:AbortSignal;original?:AnalysisOriginalCubeSource}) {
  const {title,signal,original}=options,{stage,dispose}=createAnalysisExportStaging(desktop,signal);
  try{
    const cube=await stage(original?originalPages(original,signal):encodedPages(savedCubeText(field,title),signal),original?.bytes);
    if(original&&cube.sha256!==original.sourceRevision)throw new Error('归档 Cube 原件的确切内容身份不一致。');
    const domain=await stage(encodedPages(savedCubeDomainText(field,cube.sha256),signal));
    assertResultNotAborted(signal);
    return {cube,domain,dispose};
  }catch(error){await dispose();throw error;}
}

/** Saved fields can be exported without a live native computation session. */
export async function exportSavedCube(field: ScientificGrid, name: string, options: { desktop?: CubeExportDesktop | null; title?: string; signal?: AbortSignal; original?: AnalysisOriginalCubeSource } = {}): Promise<void> {
  const { desktop, title='Ester Studio saved scientific field', signal, original }=options;
  const cubePages=original?originalPages(original,signal):encodedPages(savedCubeText(field,title),signal);
  const verifyRevision=(sha256:string)=>{if(original&&sha256!==original.sourceRevision)throw new Error('归档 Cube 原件的确切内容身份不一致。');};
  const save=desktop?.saveOwnedSurfaceCube;
  if(save&&desktop?.beginBinaryAsset&&desktop.appendBinaryAsset&&desktop.sealBinaryAsset&&desktop.releaseBinaryAsset) {
    const staged=await stageSavedCube(field,desktop,{title,signal,original});
    try {
      if((await save({name,assetId:staged.cube.id,domainAssetId:staged.domain.id})).cancelled) throw new DOMException('已取消 Cube 保存。','AbortError');
    } finally { await staged.dispose(); }
    return;
  }
  const hash=new VibronicSha256();
  const cube=await download(cubePages,'text/plain;charset=utf-8',hash), revision=hash.digest();verifyRevision(revision);
  const domain=await download(encodedPages(savedCubeDomainText(field,revision),signal),'application/json');
  assertResultNotAborted(signal);
  exportBlob(cube,name);exportBlob(domain,name+'.sciyue-domain.json');
}
