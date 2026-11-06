import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Info, X } from 'lucide-react';
import './transient-feedback.css';

export interface FeedbackMessage { id:number; text:string; kind:'success'|'error'|'info' }
export type FeedbackScope = 'global'|'instance';
export const FEEDBACK_DURATION:Record<FeedbackScope,number> = {global:4400,instance:2800};

/** Returning cancellation lets a new notice/unmount revoke the previous deadline. */
export function scheduleFeedbackDismiss(close:()=>void,durationMs:number){const timer=setTimeout(close,durationMs);return()=>clearTimeout(timer);}

function useFeedbackLifetime(notice:FeedbackMessage|null,onClose:()=>void,durationMs:number){
  const callback=useRef(onClose);callback.current=onClose;
  const identity=useRef(notice?.id);identity.current=notice?.id;
  useEffect(()=>{if(notice){const own=notice.id;return scheduleFeedbackDismiss(()=>{if(identity.current===own)callback.current();},durationMs);}},[notice?.id,durationMs]);
}

export function FeedbackMessageView({notice,scope='instance',onClose,durationMs=FEEDBACK_DURATION[scope]}:{notice:FeedbackMessage;scope?:FeedbackScope;onClose():void;durationMs?:number}){
  return <div className={'feedback-host feedback-host-'+scope} data-feedback-scope={scope}><output key={notice.id} data-feedback-id={notice.id} className={'feedback-message feedback-'+notice.kind} style={{animationDuration:durationMs+'ms'}} role={notice.kind==='error'?'alert':'status'}>
    {notice.kind==='success'?<Check size={16}/>:<Info size={16}/>}<span>{notice.text}</span><button type="button" className="feedback-close" aria-label="关闭浮动提示" onClick={onClose}><X size={14}/></button>
  </output></div>;
}

export function TransientFeedback({notice,scope='instance',onClose,durationMs=FEEDBACK_DURATION[scope]}:{notice:FeedbackMessage;scope?:FeedbackScope;onClose():void;durationMs?:number}){
  useFeedbackLifetime(notice,onClose,durationMs);
  return <FeedbackMessageView notice={notice} scope={scope} onClose={onClose} durationMs={durationMs}/>;
}

/** Each mounted owner keeps its own notice; no cross-analysis/global queue. */
export function useTransientFeedback(scope:FeedbackScope='instance'){
  const [notice,setNotice]=useState<FeedbackMessage|null>(null),serial=useRef(0);
  const notify=useCallback((text:string,kind:FeedbackMessage['kind']='info')=>setNotice({id:++serial.current,text,kind}),[]);
  const clear=useCallback(()=>setNotice(null),[]);
  useFeedbackLifetime(notice,clear,FEEDBACK_DURATION[scope]);
  return {notice,notify,clear,feedback:notice?<FeedbackMessageView notice={notice} scope={scope} onClose={clear}/>:null};
}
