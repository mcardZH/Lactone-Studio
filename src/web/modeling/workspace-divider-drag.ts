type DividerNode = Pick<HTMLElement,'dataset'>;
const gestures = new WeakMap<DividerNode,{pointerId:number;startX:number}>();

/** Transient presentation state follows the existing pointer-capture owner. */
export function beginWorkspaceDividerDrag(node:DividerNode,pointerId:number,clientX:number){
  gestures.set(node,{pointerId,startX:clientX});
  delete node.dataset.dividerDragging;
}
export function moveWorkspaceDividerDrag(node:DividerNode,pointerId:number,clientX:number){
  const gesture=gestures.get(node);
  if(gesture?.pointerId===pointerId&&clientX!==gesture.startX)node.dataset.dividerDragging='true';
}
export function endWorkspaceDividerDrag(node:DividerNode,pointerId:number){
  if(gestures.get(node)?.pointerId!==pointerId)return;
  gestures.delete(node);delete node.dataset.dividerDragging;
}
