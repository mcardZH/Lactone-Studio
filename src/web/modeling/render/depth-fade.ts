/** Global presentation strength; older display snapshots retain an off state. */
export const depthFadeAmount=(value:unknown):number=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):0;
/** Locked renderer fog uses the current camera slab and follows camera motion. */
export function depthFadeFog(value:unknown):false|{fogStart:number;fogEnd:number}{
  const amount=depthFadeAmount(value);
  return amount>0?{fogStart:.9-.75*amount,fogEnd:1.2-.25*amount}:false;
}
