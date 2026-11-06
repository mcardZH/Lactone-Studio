import type { GaussianSettings } from './types';

export type GaussianIntegral = NonNullable<GaussianSettings['integral']>;
const gridNames = ['fine', 'ultrafine', 'superfinegrid'] as const;
function integralOptions(token:string):string[] {
  return token.replace(/^\s*(?:integral|int)\s*=?\s*/i,'').replace(/^\((.*)\)$/,'$1').split(',').map(value=>value.trim()).filter(Boolean);
}
/** Only mapped options are editable; all other source options remain in inheritedRoute. */
export function parseGaussianIntegral(token:string):GaussianIntegral {
  const integral:GaussianIntegral={};
  for(const option of integralOptions(token)){
    const grid=gridNames.find(name=>name===option.toLowerCase());
    if(grid)integral.grid=grid;
    const acc2e=option.match(/^acc2e\s*=\s*([+-]?\d+)$/i);
    if(acc2e)integral.acc2e=Number(acc2e[1]);
  }
  return integral;
}
export function effectiveGaussianIntegral(settings:GaussianSettings):GaussianIntegral {
  if(settings.integral!==undefined)return settings.integral;
  if(settings.inheritedRoute?.integration)return parseGaussianIntegral(settings.inheritedRoute.integration);
  return ['b3lyp','pbe0','cam-b3lyp'].includes(settings.method)&&settings.grid==='efficient'?{grid:'fine',acc2e:10}:{};
}
export function gaussianIntegralKeyword(settings:GaussianSettings):string {
  const inherited=settings.inheritedRoute?.integration;
  if(settings.integral===undefined&&inherited)return inherited;
  const integral=effectiveGaussianIntegral(settings);
  if(inherited){
    const source=parseGaussianIntegral(inherited);
    if(source.grid===integral.grid&&source.acc2e===integral.acc2e)return inherited;
  }
  const extras=inherited?integralOptions(inherited).filter(option=>!gridNames.includes(option.toLowerCase() as typeof gridNames[number])&&!/^acc2e\s*=/i.test(option)):[];
  const options=[...(integral.grid?[integral.grid]:[]),...(integral.acc2e!==undefined?['acc2e='+integral.acc2e]:[]),...extras];
  return options.length?'int='+ (options.length===1?options[0]:'('+options.join(',')+')'):'';
}
