import { useLayoutEffect, useRef } from 'react';
import type { McCall, McpPresentationMode, McpPresentationOrigin, McTool } from './types';
import { toolError } from './types';

type Descriptor = Omit<McTool, 'call'>;
interface Incoming {
  requestId: string;
  name: string;
  arguments: Record<string, unknown>;
  session: McCall['session'];
}
export interface McpWindowPresentation {
  instanceId: string;
  windowId: string;
  ownerWindowId?: string;
  documentId?: string;
  view: 'workbench' | 'detached';
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}
export interface McpBridge {
  publish(value:{tools: Descriptor[]}):Promise<unknown>;
  state(): Promise<{instanceId:string;windowId:string}>;
  show(options:{foreground?:boolean;documentId?:string}): Promise<McpWindowPresentation>;
  file(spec:Record<string,unknown>):Promise<unknown>;
  reply(value:{requestId:string; ok:boolean; value?:unknown; error?:{code:string;message:string;data?:unknown}}):Promise<unknown>;
  onRequest(listener:(request:Incoming)=>void):()=>void;
  onCancel(listener:(request:{requestId:string})=>void):()=>void;
}
export function mcpBridge(): McpBridge | undefined {
  const bridge = (window.sciyueDesktop as unknown as {mcp?:McpBridge} | undefined)?.mcp;
  if (!bridge) return undefined;
  return { ...bridge, async file(spec) {
    const reply = await bridge.file(spec);
    const error = (reply as { mcpFileError?: { code: string; message: string; data?: unknown } } | null)?.mcpFileError;
    if (error) throw toolError(error.code, error.message, error.data);
    return reply;
  } };
}
export function presentWorkspaceWindow(mode: McpPresentationMode, documentId?: string): Promise<McpWindowPresentation> | undefined {
  return mcpBridge()?.show({ foreground: mode === 'foreground', ...(documentId === undefined ? {} : { documentId }) });
}
export function useMcpBridge(tools: McTool[],ready=true,presentationOrigin?:()=>McpPresentationOrigin) {
  const latest = useRef({ tools, presentationOrigin });
  useLayoutEffect(()=>{ latest.current={tools,presentationOrigin}; },[tools,presentationOrigin]);
  useLayoutEffect(()=>{
    const bridge=mcpBridge();
    if (!bridge||!ready) return;
    const pending=new Map<string,AbortController>();
    const detachRequest=bridge.onRequest(async request=>{
      const controller=new AbortController();
      pending.set(request.requestId,controller);
      try {
        const tool=latest.current.tools.find(item=>item.name===request.name);
        if (!tool) throw toolError('UNKNOWN_TOOL','本版 ES 未注册该工具。');
        const origin=latest.current.presentationOrigin?.();
        const value=await tool.call(request.arguments,{requestId:request.requestId,session:request.session,signal:controller.signal,
          ...(origin?{presentationOrigin:Object.freeze({...origin})}:{})});
        if (!controller.signal.aborted) await bridge.reply({requestId:request.requestId,ok:true,value:value??null});
      } catch (cause) {
        const error=cause as {code?:string;message?:string;data?:unknown};
        if (!controller.signal.aborted) await bridge.reply({requestId:request.requestId,ok:false,
          error:{code:error.code??'ES_OPERATION_FAILED',message:error.message??String(cause),data:error.data}}).catch(()=>{});
      } finally { pending.delete(request.requestId); }
    });
    const detachCancel=bridge.onCancel(({requestId})=>pending.get(requestId)?.abort());
    const descriptors=latest.current.tools.map(({name,description,inputSchema})=>({name,description,inputSchema}));
    void bridge.publish({tools:descriptors}).catch(error=>console.error('ES MCP 工具注册失败',error));
    return ()=>{
      detachRequest();detachCancel();
      for (const controller of pending.values()) controller.abort();
      void bridge.publish({tools:[]}).catch(()=>{});
    };
  },[ready]);
}
