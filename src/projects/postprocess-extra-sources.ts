import type { PostprocessDocument } from '../results/postprocess-document';
export interface PostprocessSourceExtra { name:string;sourceId:string;revision:string;byteSize:number;format:string;readRange(start:number,end:number,signal?:AbortSignal):Promise<Uint8Array> }
const extras = new WeakMap<PostprocessDocument, PostprocessSourceExtra[]>();
export function retainPostprocessSourceExtras(document:PostprocessDocument,sources:PostprocessSourceExtra[]):void { extras.set(document,sources); }
export const postprocessSourceExtras=(document:PostprocessDocument):readonly PostprocessSourceExtra[]=>extras.get(document)??[];
