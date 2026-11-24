import { StandaloneStructServiceProvider } from 'ketcher-standalone';
import { ChemicalMimeType, KetSerializer, type StructService, type StructServiceOptions } from 'ketcher-core';
import { parseKetDraft, type TwoDIndigoConverter } from '../../modeling/two-d';

// Ketcher standalone itself owns one application-lifetime worker. Every editor
// and import shares its single service so no constructor replaces onmessage.
let service: StructService | undefined;
let rawService: StructService | undefined;
let queue: Promise<unknown> = Promise.resolve();
function serializeService<T>(run:()=>Promise<T>):Promise<T>{const request=queue.then(run,run);queue=request.catch(()=>undefined);return request;}
const standalone = new StandaloneStructServiceProvider();
function getService(options: StructServiceOptions = {}) {
  if(service)return service;
  const raw=rawService=standalone.createStructService(options),queued=Object.create(raw) as StructService;
  // Standalone routes replies by command type, without request IDs. Queue all
  // declared asynchronous service methods, including the editor's direct calls.
  // Synchronous addKetcherId/destroy retain their original return/owner semantics.
  const methods=['info','convert','layout','clean','aromatize','dearomatize','calculateCip','automap','check','calculate','recognize','getInChIKey','generateImageAsBase64','toggleExplicitHydrogens','calculateMacromoleculeProperties'] as const;
  for(const name of methods){const invoke=raw[name];if(typeof invoke==='function')queued[name]=((...args:unknown[])=>serializeService(()=>Reflect.apply(invoke,raw,args))) as never;}
  if(raw.addKetcherId)queued.addKetcherId=raw.addKetcherId.bind(raw);
  if(raw.destroy)queued.destroy=raw.destroy.bind(raw);
  return service=queued;
}
export function createTwoDEditorProvider() {
  return { mode: standalone.mode, createStructService: getService,
    // The application worker is retained for subsequent imports, released by
    // the owning browser window, not by the temporary draft component.
    dispose() {} };
}
/** Validate the actual editor's format before replacing an existing session.
 * The source-audit parser and the editor have different responsibilities. */
export function assertTwoDEditorKet(ket:string):void {
  try{new KetSerializer().deserializeMicromolecules(ket);}
  catch(cause){throw new Error('二维结构包含当前编辑器无法读取的数据，原草稿已保留。',{cause});}
}
/** The editing boundary uses the existing source parser, without inventing
 * coordinates or modifying the requested graph. Empty KET remains a valid edit. */
export function assertTwoDEditorEditKet(ket:string):void {
  try{parseKetDraft(ket,{sourceId:'sketch-edit',allowEmpty:true});}
  catch(cause){
    const reason=cause instanceof Error?cause.message:String(cause);
    throw Object.assign(new Error(reason,{cause}),{code:reason.includes('坐标')?'INVALID_SKETCH_COORDINATES':'INVALID_SKETCH_KET',data:{format:'ket',reason}});
  }
}
/** Parse and lay out through the same serial Indigo service as the live editor.
 * The caller owns the draft/version check and its single native history commit. */
export function layoutTwoDSmiles(smiles:string,signal?:AbortSignal):Promise<string>{
  return serializeService(async()=>{
    signal?.throwIfAborted();
    if(!smiles.trim())throw Object.assign(new Error('SMILES 不能为空，原草稿已保留。'),{code:'INVALID_SKETCH_SMILES'});
    let result;
    try{
      // Indigo's SMILES->KET conversion generates native 2D coordinates.
      // Standalone.layout additionally looks up label rendering on its last
      // registered Ketcher ID, which may be a disposed transient macro editor.
      // This chemistry-only conversion needs no presentation-instance lookup.
      getService();result=await rawService!.convert({struct:smiles,input_format:ChemicalMimeType.DaylightSmiles,output_format:ChemicalMimeType.KET});
    }catch(cause){
      signal?.throwIfAborted();
      const reason=cause instanceof Error?cause.message:String(cause);
      const invalidInput=/SMILES|could not be loaded|molecule.*loader|scanner|syntax|parse|cycle|ring|valence/i.test(reason);
      throw Object.assign(new Error(invalidInput?'SMILES 原生解析失败，原草稿已保留。':'原生二维转换服务未完成，原草稿已保留。',{cause}),{code:invalidInput?'INVALID_SKETCH_SMILES':'SKETCH_LAYOUT_FAILED',data:{format:'smiles',reason}});
    }
    signal?.throwIfAborted();
    if(!result.struct)throw Object.assign(new Error('原生 SMILES 排版未返回二维结构，原草稿已保留。'),{code:'SKETCH_LAYOUT_FAILED'});
    assertTwoDEditorEditKet(result.struct);
    return result.struct;
  });
}
function base64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
/** Share standalone's existing worker/event queue with imports and editors. */
export function calculateGeometryCip(struct:string,signal?:AbortSignal):Promise<string>{
  const run=async()=>{
    signal?.throwIfAborted();
    getService();const result=await rawService!.calculateCip({struct,output_format:ChemicalMimeType.KET});
    signal?.throwIfAborted();
    if(!result.struct)throw Error('Indigo未返回立体化学结构。');
    return result.struct;
  };
  return serializeService(run);
}
export const twoDIndigoConverter: TwoDIndigoConverter = {
  convert(input, options) {
    // Standalone's event channel has no request IDs, so imports are serialized.
    const run = async () => {
      options.signal?.throwIfAborted();
      const struct = input instanceof Uint8Array
        ? options.inputFormat === 'cdx' ? `base64::${base64(input)}` : new TextDecoder('utf-8', { fatal: true }).decode(input)
        : input;
      getService();const result = await rawService!.convert({ struct, output_format: ChemicalMimeType.KET });
      options.signal?.throwIfAborted();
      if (!result.struct) throw new Error('Indigo未返回二维结构。');
      return result.struct;
    };
    return serializeService(run);
  },
};
