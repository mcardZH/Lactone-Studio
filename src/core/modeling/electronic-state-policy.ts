import {electronicStateError,suggestedMultiplicity} from '../elements';
import type {Atom,Structure} from '../types';

/** Membership and elements determine electron inventory; numbering, formal
 * charges, coordinates and display bonds do not change the chosen total q. */
export function electronicInventorySignature(structure:Pick<Structure,'atoms'>|null):string {
  return JSON.stringify(structure?.atoms.map(atom=>[atom.id??null,atom.element]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))??null);
}

type Pair={charge:number|null;multiplicity:number|null};
export function reconcileElectronicStateAfterInventoryEdit<T extends Pair>(atoms:readonly Atom[],previous:T):T&{reset:boolean;warning:string|null}{
  const retained={...previous,reset:false,warning:null as string|null};
  if(!atoms.length)return retained;
  if(previous.charge===null||!Number.isSafeInteger(previous.charge))return {...retained,warning:'总电荷必须是整数，请核对电子态。'};
  try{
    if(previous.multiplicity!==null&&!electronicStateError([...atoms],previous.charge,previous.multiplicity))return retained;
    const multiplicity=suggestedMultiplicity([...atoms],previous.charge);
    const warning=electronicStateError([...atoms],previous.charge,multiplicity);
    return warning?{...retained,warning}:{...retained,multiplicity,reset:multiplicity!==previous.multiplicity};
  }catch(cause){return {...retained,warning:cause instanceof Error?cause.message:'无法确定电子数，请核对结构和电子态。'};}
}

/** Existing models retain their own total q. New sources initialize separately. */
export function electronicStateAfterModelEdit(previous:Structure,next:Structure){
  return reconcileElectronicStateAfterInventoryEdit(next.atoms,{charge:previous.charge,multiplicity:previous.multiplicity});
}
