/** Keep local reset Undo limited to the fields that the reset actually changed. */
export function inputResetPaths(before:unknown,after:unknown,path:string[]=[]):string[][] {
  if(JSON.stringify(before)===JSON.stringify(after))return [];
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after))return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key=>inputResetPaths((before as Record<string,unknown>)[key],(after as Record<string,unknown>)[key],[...path,key]));
  return [path];
}
export function applyInputResetPatch<T>(current:T,saved:T,paths:readonly string[][]):T {
  let next=structuredClone(current);
  for(const path of paths){if(!path.length){next=structuredClone(saved);continue;}let target=next as Record<string,unknown>,source=saved as Record<string,unknown>|undefined;for(const key of path.slice(0,-1)){target[key]??={};target=target[key] as Record<string,unknown>;source=source?.[key] as Record<string,unknown>|undefined;}const last=path.at(-1)!;if(source&&Object.hasOwn(source,last))target[last]=structuredClone(source[last]);else delete target[last];}
  return next;
}
