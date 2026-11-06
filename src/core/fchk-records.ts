/** FCHK record boundaries belong to core. Character payload is consumed by
 * count before any header recognition; H is an opaque 9A8 byte record. */
export interface FchkField { label:string;type:string;count?:number;token?:string }
export interface FchkRecord { text:string;sourceLine:number;start:number;end:number;field?:FchkField;character?:{label:string;type:'C'|'H';count:number} }
export function fchkField(text:string):FchkField|null{
 const m=text.match(/^(.+?)\s+([IRCLH])\s+(?:N=\s*(\d+)\s*|(\S+)\s*)$/);
 if(!m)return null;return{label:m[1].trim(),type:m[2],...(m[3]===undefined?{token:m[4]}:{count:Number(m[3])})};
}
export function looksLikeFchk(text:string):boolean{return /^Number of atoms\s+I\s+\d+\s*$/m.test(text)&&/^Atomic numbers\s+I\s+N=\s*\d+\s*$/m.test(text);}
/** Direct string consumers must prove the exact record width too. ASCII H is
 * lossless; non-ASCII H text is ambiguous and requires original file bytes. */
export function fchkCharacterRecord(raw:string,type:string,remaining:number,byteProven=false):{text:string;count:number}{
 const width=type==='C'?12:8,count=Math.min(remaining,type==='C'?5:9),expected=count*width;
 const length=(s:string)=>type==='H'?s.length:new TextEncoder().encode(s).length;
 let text=raw;
 if(length(text)===expected+1&&text.endsWith('\r'))text=text.slice(0,-1);
 if(type==='H'&&[...text].some(c=>c.charCodeAt(0)>(byteProven?255:127)))throw new Error('FCHK H文本的原字节宽度不可证明，请提供原始文件字节。');
 if(length(text)!==expected)throw new Error(`FCHK ${type}字符记录宽度无效：需${expected}字节，不能将负载当字段。`);
 return{text,count};
}
export class FchkRecordScanner{
 private pending=new Uint8Array(0);private offset=0;private line=1;private records=0;
 private active:{label:string;type:'C'|'H';remaining:number}|null=null;
 private decoder=new TextDecoder('utf-8',{fatal:true});
 constructor(private options:{maxLineBytes?:number;textMode?:boolean;fchk?:boolean}={}){}
 push(bytes:Uint8Array,final=false):FchkRecord[]{
  const merged=new Uint8Array(this.pending.length+bytes.length);merged.set(this.pending);merged.set(bytes,this.pending.length);this.pending=merged;
  const out:FchkRecord[]=[];
  while(this.pending.length){
   let length=-1,separator=0,character:FchkRecord['character'];
   if(this.active){
    const n=Math.min(this.active.remaining,this.active.type==='C'?5:9);length=n*(this.active.type==='C'?12:8);
    if(this.pending.length<length){if(final)throw new Error(`FCHK ${this.active.label}字符记录截断/坏宽度。`);break;}
    if(this.pending.length===length&&!final)break;
    if(this.pending.length>length){const next=this.pending[length];if(next!==10&&next!==13)throw new Error(`FCHK ${this.active.label}字符记录超过固定宽度。`);if(next===13&&this.pending.length===length+1&&!final)break;separator=next===13&&this.pending[length+1]===10?2:1;}
    character={label:this.active.label,type:this.active.type,count:n};
   }else{
    length=this.pending.findIndex(b=>b===10||b===13);
    if(length<0){if(!final){if(this.options.maxLineBytes!==undefined&&this.pending.length>this.options.maxLineBytes)throw new Error('FCHK单行超过调用方指定读取范围。');break;}length=this.pending.length;}
    else{if(this.pending[length]===13&&length===this.pending.length-1&&!final)break;separator=this.pending[length]===13&&this.pending[length+1]===10?2:1;}
   }
   if(this.options.maxLineBytes!==undefined&&length>this.options.maxLineBytes)throw new Error('FCHK单行超过调用方指定读取范围。');
   const payload=this.pending.subarray(0,length);let text:string;
   if(character?.type==='H'){
    if(this.options.textMode&&payload.some(b=>b>127))throw new Error('FCHK H文本的原字节宽度不可证明，请提供原始文件字节。');
    text=Array.from(payload,b=>String.fromCharCode(b)).join('');
   }else{text=this.decoder.decode(payload);if(text.includes('\0'))throw new Error('FCHK非H文本字段含二进制/UTF-16内容。');}
   const field=!character&&this.records>=2?fchkField(text):null;
   const record:FchkRecord={text,sourceLine:this.line,start:this.offset,end:this.offset+length+separator,...(field?{field}:{}),...(character?{character}:{})};out.push(record);this.records++;
   if(character){this.active!.remaining-=character.count;if(!this.active!.remaining)this.active=null;}
   else if(this.options.fchk!==false&&field&&(field.type==='C'||field.type==='H')&&field.count!==undefined){if(!Number.isSafeInteger(field.count)||field.count<0)throw new Error('FCHK字符数组长度声明无效。');if(field.count)this.active={label:field.label,type:field.type,remaining:field.count};}
   const consumed=length+separator;let newlines=0;for(let i=0;i<consumed;i++)if(this.pending[i]===10)newlines++;
   this.line+=newlines+(separator&&this.pending[length]===13&&this.pending[length+1]!==10?1:0);this.offset+=consumed;this.pending=this.pending.subarray(consumed);
  }
  if(final&&this.active)throw new Error(`FCHK ${this.active.label}字符数组截断。`);
  return out;
 }
}
export function fchkTextRecords(text:string):FchkRecord[]{const scanner=new FchkRecordScanner({textMode:true});return scanner.push(new TextEncoder().encode(text),true);}
export interface FchkByteSource{size:number;stream():ReadableStream<Uint8Array>}
export interface FchkRecordOptions{signal?:AbortSignal;maxFileBytes?:number;maxLineBytes?:number;onProgress?:(read:number,total:number)=>void;fchk?:boolean}
export async function* streamFchkRecords(file:FchkByteSource,options:FchkRecordOptions={}):AsyncGenerator<FchkRecord>{
 const reader=file.stream().getReader(),scanner=new FchkRecordScanner(options);let bytes=0,records=0,complete=false;
 const check=()=>{if(options.signal?.aborted)throw new DOMException('已取消FCHK读取。','AbortError');};
 const abort=()=>{void reader.cancel().catch(()=>undefined);};options.signal?.addEventListener('abort',abort,{once:true});
 try{while(true){check();const next=await reader.read();check();if(next.done){complete=true;break;}bytes+=next.value.length;if(options.maxFileBytes!==undefined&&bytes>options.maxFileBytes)throw new Error('FCHK超过调用方指定读取范围。');
  for(let offset=0;offset<next.value.length;offset+=65536)for(const record of scanner.push(next.value.subarray(offset,offset+65536))){yield record;if(++records%1024===0){check();await new Promise<void>(resolve=>setTimeout(resolve,0));}}
  options.onProgress?.(bytes,file.size);
 }for(const record of scanner.push(new Uint8Array(),true))yield record;
 if(bytes!==file.size)throw new Error('FCHK来源读取长度发生变化。');
 }finally{options.signal?.removeEventListener('abort',abort);if(!complete)await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
/** A parsing representation only. Raw identity/hash must always use source
 * bytes; H payload is blanked while retaining its byte width and CR/LF. */
export function fchkRecordText(record:FchkRecord):string{return record.character?.type==='H'?record.text.replace(/[^\r\n]/g,' '):record.text;}
