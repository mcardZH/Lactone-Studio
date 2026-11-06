import type {FragmentSnapshot} from '../../modeling/contracts';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {advancedFrameFragment} from '../../modeling/application/advanced-frame-output';
export {advancedFrameFragment} from '../../modeling/application/advanced-frame-output';
/** Confirmation is resolved before the first document/task write. */
export function prepareAdvancedFrameInput(source:AdvancedFrameSource,ports:{hasDirtyInput:boolean;busy:boolean;create(fragment:FragmentSnapshot):string;start(id:string):void},confirmed=false):'confirmation-required'|'started'{
 if(ports.busy)throw Error('输入正在处理，请完成或取消后再准备输入。');
 if(ports.hasDirtyInput&&!confirmed)return'confirmation-required';
 const fragment=advancedFrameFragment(source),id=ports.create(fragment);ports.start(id);return'started';
}
