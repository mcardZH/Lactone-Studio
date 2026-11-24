import type { AdvancedController } from '../../modeling/advanced/controller';

const revisions = new WeakMap<AdvancedController, Map<string,number>>();
const listeners = new WeakMap<AdvancedController, Set<() => void>>();

export function conformerMcpConfigurationRevision(controller:AdvancedController,taskId?:string) {
  return taskId ? revisions.get(controller)?.get(taskId) ?? 0 : 0;
}

export function publishConformerMcpConfiguration(controller:AdvancedController,taskId:string) {
  const byTask=revisions.get(controller)??new Map();
  byTask.set(taskId,conformerMcpConfigurationRevision(controller,taskId)+1);
  revisions.set(controller,byTask);
  listeners.get(controller)?.forEach(listener=>listener());
}

export function subscribeConformerMcpConfiguration(controller:AdvancedController,listener:()=>void) {
  const active=listeners.get(controller)??new Set();
  active.add(listener);
  listeners.set(controller,active);
  return ()=>{active.delete(listener);};
}
