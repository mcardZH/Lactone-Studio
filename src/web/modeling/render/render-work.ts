/** Cooperative display work only; no structure edits or scientific method changes. */
export type RenderWork<T> = Generator<void|((signal?:AbortSignal)=>Promise<void>), T, void>;
export function finishRenderWork<T>(work:RenderWork<T>):T{let step=work.next();while(!step.done){if(step.value)throw Error('此显示任务需要异步准备。');step=work.next();}return step.value;}
export async function runRenderWork<T>(work:RenderWork<T>,signal?:AbortSignal,current?:()=>boolean):Promise<T>{
  let deadline=performance.now()+8;
  try{while(true){if(signal?.aborted||current?.()===false)throw new DOMException('显示准备已取消。','AbortError');const step=work.next();if(step.done)return step.value;if(step.value)await step.value(signal);
    if(performance.now()>=deadline){await new Promise<void>(resolve=>setTimeout(resolve,0));deadline=performance.now()+8;}
  }}finally{work.return(undefined as T);}
}
