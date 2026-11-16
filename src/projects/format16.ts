/** CALC histories and relative-stereo representation carry new source semantics. */
export function requiresProjectFormat16(root:unknown):boolean {
  const pending:unknown[]=[root],seen=new WeakSet<object>();
  while(pending.length){
    const value=pending.pop();if(!value||typeof value!=='object'||seen.has(value)||ArrayBuffer.isView(value))continue;
    seen.add(value);
    if(Array.isArray(value)){pending.push(...value);continue;}
    const row=value as Record<string,unknown>;
    if(row.calcProfile==='es-calc/v1'||row.calcSequence!==undefined||row.operation==='opt'&&row.schema==='es-pes/v1')return true;
    if(row.schema==='es-2d-stereo-representative/v1')return true;
    if(row.schema==='es-2d-stereo/v1'&&Array.isArray(row.stereoGroups)&&row.stereoGroups.some(value=>
      value&&typeof value==='object'&&['AND','OR'].includes(String((value as Record<string,unknown>).type))))return true;
    for(const [key,child] of Object.entries(row))if(!['atoms','positions','velocities','coordinates','matrixHartreePerBohr2','displacements'].includes(key)&&child&&typeof child==='object')pending.push(child);
  }
  return false;
}
