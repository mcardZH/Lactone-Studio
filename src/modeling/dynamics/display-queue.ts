/** Real display snapshots only. Limits count UTF-8 serialized frame payloads,
 * not process RSS, scientific history, or a target/observed rendering rate. */
export const DISPLAY_FRAME_LIMIT = 24;
export const DISPLAY_BYTE_LIMIT = 2 * 1024 * 1024;
export const DISPLAY_INTERVAL_MS = 33;
export const DISPLAY_MAX_WAIT_MS = DISPLAY_FRAME_LIMIT * DISPLAY_INTERVAL_MS;
export const serializedFrameBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export class BoundedDisplayQueue<T> {
  private entries: { value:T; bytes:number; receivedAt:number }[] = [];
  private bytes = 0;
  constructor(private readonly maxFrames=DISPLAY_FRAME_LIMIT,private readonly maxBytes=DISPLAY_BYTE_LIMIT) {
    if(!Number.isSafeInteger(maxFrames)||maxFrames<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('显示队列上限无效。');
  }
  get count():number { return this.entries.length; }
  get byteLength():number { return this.bytes; }
  get oldestReceivedAt():number|undefined { return this.entries[0]?.receivedAt; }
  push(value:T,receivedAt:number):boolean {
    const bytes=serializedFrameBytes(value);
    if(bytes>this.maxBytes)return false;
    while(this.entries.length && (this.entries.length>=this.maxFrames || this.bytes+bytes>this.maxBytes))this.shift();
    this.entries.push({value,bytes,receivedAt});this.bytes+=bytes;return true;
  }
  shift():T|undefined {const entry=this.entries.shift();if(!entry)return undefined;this.bytes-=entry.bytes;return entry.value;}
  clear():void {this.entries=[];this.bytes=0;}
}

export interface DisplayScheduler { now():number; request(callback:()=>void,delayMs:number):()=>void }
/** Browsers align delivery to rAF after the minimum interval. Headless use has
 * an explicit timer fallback; neither path promises a measured frame rate. */
export function createDisplayScheduler():DisplayScheduler {
  const now=()=>globalThis.performance?.now()??Date.now();
  return {now,request(callback,delayMs){
    if(typeof globalThis.requestAnimationFrame==='function'){
      const target=now()+delayMs;let token=0,cancelled=false;
      const tick=()=>{if(cancelled)return;if(now()<target)token=globalThis.requestAnimationFrame(tick);else callback();};
      token=globalThis.requestAnimationFrame(tick);
      return()=>{cancelled=true;globalThis.cancelAnimationFrame(token);};
    }
    const token=setTimeout(callback,delayMs);return()=>clearTimeout(token);
  }};
}
