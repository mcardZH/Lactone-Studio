import type {ModelStore} from '../contracts';
import type {WorkspaceCommand,WorkspaceHistoryOwner} from '../workspace-contracts';
import type {DynamicsController} from '../dynamics/controller';
import {defaultElementPresetId} from '../../core/modeling/element-presets';
const safeModelTypes=new Set(['place-element','place-fragment','place-copied-fragment','add-single-hydrogen','delete-objects','set-bond-order','break-bond','transform-fragment','manual-coordinates']);
/** This handler stays at the authoritative application boundary. It never
 * starts a second runtime or accepts remote engine/context replacement. */
export function applyWorkspaceOwnerCommand(store:ModelStore,command:WorkspaceCommand,expectedRevision:number,controller?:DynamicsController,historyOwner?:WorkspaceHistoryOwner):void {
 if(store.getSnapshot().revision!==expectedRevision)throw new Error('模型修订已变化，请重新操作。');
 if(!store.hasTransaction)throw new Error('缺少权威事务状态，不能提交共享编辑。');
 if(store.hasTransaction())throw new Error('模型正在进行手势、几何编辑或动态事务，请结束后再操作。');
 if(command.type==='model.select'){store.select(command.selection);return;}
 if(command.type!=='model.execute'&&command.type!=='model.undo'&&command.type!=='model.redo')throw new Error('此共享视图不接受任务上下文或运行请求，请在文档主工作台操作。');
 controller?.assertCanEditStructure();
 if(command.type==='model.execute'&&!safeModelTypes.has(command.command?.type))throw new Error('此共享视图不支持该建模命令。');
 controller?.beforeExternalEdit('共享视图提交了模型编辑');
 if(command.type==='model.execute'){const modelCommand=command.command;store.execute(modelCommand.type==='place-element'&&!modelCommand.presetId?{...modelCommand,presetId:defaultElementPresetId(modelCommand.element)}:modelCommand);}else if(command.type==='model.undo'){if(historyOwner)historyOwner.undo(store.getSnapshot().id);else store.undo();}else {if(historyOwner)historyOwner.redo(store.getSnapshot().id);else store.redo();}
}
