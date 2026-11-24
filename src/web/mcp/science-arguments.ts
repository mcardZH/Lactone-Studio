import { objectSchema, toolError } from './types';
import type { BaseElectronicStateValues } from '../../core/base-electronic-state';

export const targetSchema = { oneOf: [
  {type:'string',description:'A modelRef or opaque frameRef issued by this ES connection.'},
  objectSchema({ modelRef:{type:'string'},revision:{type:'integer',minimum:0} },['modelRef']),
  objectSchema({ frameRef:{type:'string'} },['frameRef']),
] };

export function record(value:unknown,label:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw toolError('INVALID_ARGUMENT',label+' 需要对象。');
  return value as Record<string,unknown>;
}

export function textValue(value:unknown,label:string):string{
  if(typeof value!=='string'||!value.trim())throw toolError('INVALID_ARGUMENT',label+' 需要非空文本。');
  return value;
}

export function integer(value:unknown,label:string,minimum=Number.MIN_SAFE_INTEGER):number|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<minimum)throw toolError('INVALID_ARGUMENT',label+' 需要有效整数。');
  return value;
}

export function electronicOptions(value:unknown):BaseElectronicStateValues|undefined{
  if(value===undefined)return;
  const options=record(value,'electronic');
  const charge=integer(options.charge,'charge'),multiplicity=integer(options.multiplicity,'multiplicity',1);
  if(charge===undefined||multiplicity===undefined)throw toolError('INVALID_ARGUMENT','请同时指定电荷和自旋多重度。');
  return {charge,multiplicity};
}

export function positive(value:unknown,label:string):number|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw toolError('INVALID_ARGUMENT',label+' 需要大于零的有限数。');
  return value;
}

export function oneOf<const T extends readonly string[]>(value:unknown,values:T,label:string):T[number]|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!values.includes(value))throw toolError('INVALID_ARGUMENT',label+' 的可用值为 '+values.join(', ')+'。');
  return value as T[number];
}

export function flag(value:unknown,label:string):boolean|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='boolean')throw toolError('INVALID_ARGUMENT',label+' 需要布尔值。');
  return value;
}

export function textArray(value:unknown,label:string):string[]{
  if(!Array.isArray(value))throw toolError('INVALID_ARGUMENT',label+' 需要原子 ID 列表。');
  return value.map(item=>textValue(item,label));
}
