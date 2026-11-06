import type {TaskSystemBridge,TaskSystemCommands} from '../application-contracts';

/** The app composition seam, never a dependency of task domain or scientific parsers. */
export interface NativeTaskSystemPort {
  taskSystemRequest(request:{requestId:string;command:string;input:unknown}):Promise<unknown>;
  cancelTaskSystemRequest(requestId:string):Promise<void>;
}

export function desktopTaskSystemPort():NativeTaskSystemPort|null {
  if(typeof window==='undefined')return null;
  const port=window.sciyueDesktop as unknown as Partial<NativeTaskSystemPort>|undefined;
  return typeof port?.taskSystemRequest==='function'&&typeof port.cancelTaskSystemRequest==='function'?port as NativeTaskSystemPort:null;
}

export function createTaskSystemBridge(port:NativeTaskSystemPort|null=desktopTaskSystemPort()):TaskSystemBridge {
  return {async request<C extends keyof TaskSystemCommands>(command:C,input:TaskSystemCommands[C]['input'],options?:{signal?:AbortSignal}):Promise<TaskSystemCommands[C]['result']>{
    if(!port)throw new Error('外部任务中心需要桌面版。');
    if(options?.signal?.aborted)throw new DOMException('已取消读取。','AbortError');
    const requestId=crypto.randomUUID(),cancel=()=>{void port.cancelTaskSystemRequest(requestId).catch(()=>{});};
    options?.signal?.addEventListener('abort',cancel,{once:true});
    try{return await port.taskSystemRequest({requestId,command,input}) as TaskSystemCommands[C]['result'];}
    finally{options?.signal?.removeEventListener('abort',cancel);}
  }};
}
