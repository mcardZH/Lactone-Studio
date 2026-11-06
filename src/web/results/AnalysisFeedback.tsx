import {useTransientFeedback} from '../TransientFeedback';
/** Short interaction feedback; persistent scientific/runtime errors stay separate. */
export function useAnalysisFeedback(){
 return useTransientFeedback('instance');
}
