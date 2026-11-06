import { TransientFeedback } from './TransientFeedback';
export interface Notice { id:number;text:string;kind:'success'|'error' }
export default function NoticeToast({notice,onClose}:{notice:Notice;onClose:()=>void}){
  return <TransientFeedback notice={notice} scope="global" onClose={onClose}/>;
}
