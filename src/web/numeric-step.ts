/** Decimal stepping for scientific display controls. Never round through binary addition. */
function decimalPlaces(text:string):number {
  const [mantissa,exponent='0']=text.toLowerCase().split('e');
  return Math.max(0,(mantissa.split('.')[1]?.length??0)-Number(exponent));
}

/** Keep the native range from quantizing a legal value entered in its number field.
 * Only the display range changes; validation remains with the owning control. */
export function matchingSliderRange(value:number,min:number,max:number,step:number) {
  if(![value,min,max,step].every(Number.isFinite)||step<=0)return{min,max,step};
  return {min:Math.min(min,value),max:Math.max(max,value),step:Math.min(step,10**-decimalPlaces(String(value)))};
}

export function adaptiveNumericStep(raw:string,direction:1|-1,base:number,min?:number|string,max?:number|string):string|null {
  const value=raw.trim()===''?0:Number(raw);
  if(!Number.isFinite(value)||!Number.isFinite(base)||base<=0)return null;
  const precision=decimalPlaces;
  let places=Math.max(precision(String(base)),Math.abs(value)<base?precision(raw):0);
  let step=Math.abs(value)>=base?base:10**-places;
  const inward=value!==0&&Math.sign(value)!==direction;
  if(inward&&Math.abs(value)<=step){places++;step=10**-places;}
  if(value===0){step=base;places=precision(String(base));}
  places=Math.max(places,precision(raw),precision(String(step)));
  const integer=(text:string)=>{const negative=text.startsWith('-');const unsigned=text.replace(/^[+-]/,'');const [mantissa,exponent='0']=unsigned.toLowerCase().split('e');const digits=mantissa.replace('.','')||'0';const decimals=mantissa.split('.')[1]?.length??0;const power=places+Number(exponent)-decimals;return BigInt(digits)*10n**BigInt(Math.max(0,power))*(negative?-1n:1n);};
  const next=integer(raw.trim()===''?'0':raw)+BigInt(direction)*integer(String(step));
  const negative=next<0n;let digits=(negative?-next:next).toString().padStart(places+1,'0');
  const output=(negative?'-':'')+(places?digits.slice(0,-places)+'.'+digits.slice(-places):digits);
  const boundedMin=min===undefined?undefined:Number(min),boundedMax=max===undefined?undefined:Number(max);
  if(Number.isFinite(boundedMin)&&Number(output)<boundedMin!)return String(min);
  if(Number.isFinite(boundedMax)&&Number(output)>boundedMax!)return String(max);
  return output;
}
