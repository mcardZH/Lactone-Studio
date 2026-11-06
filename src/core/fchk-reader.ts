import { elementSymbol } from './elements';
import { BASES, METHODS, canonicalBasis } from './catalog';
import { gaussianRouteTokens, parseGaussianSource } from './gaussian-source';
import type { Structure } from './types';
import { fchkCharacterRecord } from './fchk-records';

const BOHR=0.529177210903;
const numeric=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
/** Fortran Ew.d may omit E for a signed three-digit exponent. Keep the
 * original token at its owner; this conversion never substitutes missing data. */
export function normalizedFchkNumber(token:string):string|null{
  const implicit=token.match(/^([+-]?(?:\d+\.\d*|\.\d+))([+-]\d{3})$/);
  if(!numeric.test(token)&&!implicit)return null;
  const normalized=implicit?`${implicit[1]}e${implicit[2]}`:token.replace(/[dD]/,'e');
  const value=Number(normalized);
  if(value===0&&/[1-9]/.test(normalized.split(/[eE]/)[0]))return null;
  return Number.isFinite(value)?normalized:null;
}
export function fchkNumber(token:string):number|null{const normalized=normalizedFchkNumber(token);return normalized===null?null:Number(normalized);}
/** Gaussian A10/A30/A30 and Multiwfn's wider method column may carry an
 * explicit TD-FC qualifier before the basis. Unknown words remain untouched. */
export function fchkHeaderFields(header:string):{task:string;method:string;basis:string;methodModifier?:'TD-FC'}{
  const parts=header.trim().match(/^(\S+)\s+(\S+)(?:\s+(.+?))?\s*$/);
  const tail=parts?.[3]?.trim()??'',qualified=tail.match(/^TD-FC\s+(\S.*)$/i);
  return {task:parts?.[1]??'',method:parts?.[2]??'',basis:qualified?.[1]??tail,...(qualified?{methodModifier:'TD-FC' as const}:{})};
}

function sameHeaderLevel(method:string,basis:string,route:string):boolean{
  const tokens=gaussianRouteTokens(route),routeLevel=tokens.find(token=>/^[a-z][\w-]*(?:\([^)]*\))?\//i.test(token)&&!/^iop\b/i.test(token));
  const slash=routeLevel?.indexOf('/')??-1;
  const routeMethod=(routeLevel?.slice(0,slash)??tokens.find(token=>METHODS.some(entry=>entry.keyword.toLowerCase()===token.toLowerCase())))?.toLowerCase();
  const routeBasis=routeLevel?.slice(slash+1)??tokens.find(token=>/^(?:gen|genecp)$/i.test(token)||BASES.some(entry=>entry.value===canonicalBasis(token)));
  const headerMethod=method.toLowerCase();
  // An omitted reference prefix in Route is compatible with the explicit saved
  // header (RM052X vs M052X); explicit R/U disagreements remain conflicts.
  const methodsAgree=!routeMethod||headerMethod===routeMethod||headerMethod.replace(/^(?:ro|r|u)/,'')===routeMethod||routeMethod.replace(/^(?:ro|r|u)/,'')===headerMethod;
  const normalizeBasis=(value:string)=>canonicalBasis(value).toLowerCase().replace(/\(d,p\)$/,'**').replace(/\(d\)$/,'*');
  return methodsAgree&&(!routeBasis||/^(?:gen|genecp)$/i.test(basis)||/^(?:gen|genecp)$/i.test(routeBasis)||normalizeBasis(basis)===normalizeBasis(routeBasis));
}
/** Keeps geometry and small metadata, skips MO/density arrays without retaining their contents. */
export class FchkReader {
  private line=0;private title='';private header='';private scalars=new Map<string,number>();private arrays=new Map<string,number[]>();private chars=new Map<string,string>();
  private active:{label:string;type:string;remaining:number;capture:boolean;values:number[];text:string}|null=null;
  private warnings:string[]=[];
  private partial=false;
  private skipDamaged=false;
  private seen=new Set<string>();private invalid=new Set<string>();
  private requiredGeometry(label:string):boolean{return ['Atomic numbers','Current cartesian coordinates'].includes(label);}
  get incomplete():boolean{return this.partial;}
  private damagedArray(label:string,message:string):void{
    this.partial=true;this.warnings.push(`FCHK ${label} ${message}；已隔离该未使用字段，保留此前完整数据，不代表完整波函数。`);this.active=null;this.skipDamaged=true;
  }
  consume(raw:string,context?:{sourceLine:number;byteProven?:boolean}):void{
    this.line=context?.sourceLine??this.line+1;
    if(this.active&&(this.active.type==='C'||this.active.type==='H')&&this.active.remaining){
      const part=fchkCharacterRecord(raw,this.active.type,this.active.remaining,context?.byteProven);
      if(this.active.capture)this.active.text+=part.text;this.active.remaining-=part.count;
      if(!this.active.remaining)this.complete();return;
    }
    const line=raw.replace(/^\uFEFF/,'').replace(/\r$/,'');
    if(this.line===1){this.title=line.trim();return;}if(this.line===2){this.header=line;return;}
    const field=line.match(/^(.+?)\s+([IRCLH])\s+(?:N=\s*(\d+)\s*|(\S+)\s*)$/);
    if(field){
      if(this.active?.remaining){if(this.requiredGeometry(this.active.label))throw new Error(`FCHK的${this.active.label}截断。`);this.damagedArray(this.active.label,'数组未满声明长度');}
      this.active=null;this.skipDamaged=false;const label=field[1].trim(),type=field[2];
      if(this.seen.has(label)&&['Number of atoms','Atomic numbers','Current cartesian coordinates','Charge','Multiplicity','Nuclear charges','Real atomic weights','Route','Full Title'].includes(label)){
        if(this.requiredGeometry(label)||label==='Number of atoms')throw new Error(`FCHK字段 ${label} 重复。`);
        this.invalid.add(label);this.scalars.delete(label);this.arrays.delete(label);this.chars.delete(label);this.damagedArray(label,'字段重复');
      }
      this.seen.add(label);
      if(field[3]!==undefined){const remaining=Number(field[3]);if(!Number.isSafeInteger(remaining)||remaining<0)throw new Error('FCHK数组长度声明无效。');
        const capture=['Atomic numbers','Current cartesian coordinates','Nuclear charges','Real atomic weights','Route','Full Title'].includes(label);
        this.active={label,type,remaining,capture,values:[],text:''};if(!remaining)this.complete();
      }else if(['I','R'].includes(type)){
        const value=fchkNumber(field[4]);
        if(value===null||(type==='I'||['Charge','Multiplicity'].includes(label))&&!Number.isSafeInteger(value)){
          if(label==='Number of atoms')throw new Error(`FCHK标量 ${label} 含无效数据。`);
          this.damagedArray(label,'标量损坏');return;
        }
        if(label==='Multiplicity'&&value<1){this.damagedArray(label,'多重度无效');return;}
        if(!this.invalid.has(label))this.scalars.set(label,value);
      }
      return;
    }
    if(!this.active){if(!this.skipDamaged&&line.trim()&&this.line>2&&!this.warnings.includes('来源含未映射FCHK字段/续行。'))this.warnings.push('来源含未映射FCHK字段/续行。');return;}
    const active=this.active;
    {
      const values=line.trim()?line.trim().split(/\s+/):[];
      if(!values.length)return;
      if(values.some(v=>active.type==='L'?!/^[TF]$/.test(v):fchkNumber(v)===null||active.type==='I'&&!Number.isSafeInteger(fchkNumber(v)))){
        if(this.requiredGeometry(active.label))throw new Error(`FCHK数组 ${active.label} 含无效数据。`);
        this.damagedArray(active.label,'含损坏或截断数值');return;
      }
      if(values.length>active.remaining){if(this.requiredGeometry(active.label))throw new Error(`FCHK的${active.label}包含额外数值。`);this.damagedArray(active.label,'超过声明长度');return;}
      active.remaining-=values.length;if(active.capture)for(const value of values)active.values.push(fchkNumber(value)!);
    }
    if(!active.remaining)this.complete();
  }
  private complete(){const active=this.active!;if(active.capture&&!this.invalid.has(active.label)){if(active.type==='C'||active.type==='H')this.chars.set(active.label,active.text.trimEnd());else this.arrays.set(active.label,active.values);}this.active=null;}
  finish(name:string):Structure[]{
    if(this.active?.remaining){if(this.requiredGeometry(this.active.label))throw new Error(`FCHK的${this.active.label}截断。`);this.damagedArray(this.active.label,'尾部数组截断');}
    const count=this.scalars.get('Number of atoms'),zs=this.arrays.get('Atomic numbers'),coords=this.arrays.get('Current cartesian coordinates');
    if(!count||!Number.isSafeInteger(count)||count<1)throw new Error('FCHK缺少有效正整数Number of atoms。');
    if(zs?.length!==count||coords?.length!==count*3)throw new Error('FCHK的Atomic numbers或Current cartesian coordinates长度与原子数不符/缺失。');
    const atoms=zs.map((z,i)=>{if(!Number.isInteger(z)||z<1||z>118)throw new Error('FCHK含dummy/ghost或未知元素，不能静默丢弃。');return {element:elementSymbol(String(z)),x:coords[i*3]*BOHR,y:coords[i*3+1]*BOHR,z:coords[i*3+2]*BOHR};});
    if(atoms.some(a=>![a.x,a.y,a.z].every(Number.isFinite)))throw new Error('FCHK坐标必须为有限数字。');
    const sourceRoute=this.chars.get('Route')?.trim(),{method,basis,task,methodModifier}=fchkHeaderFields(this.header);
    const route=sourceRoute??(method&&basis?`# ${task.toLowerCase()==='freq'?'freq ':task.toLowerCase()==='fopt'?'opt ':''}${method}/${basis}`:'');
    const source=parseGaussianSource(route,'fchk',name);source.title=this.chars.get('Full Title')??this.title;
    source.charge=this.scalars.get('Charge')??null;source.multiplicity=this.scalars.get('Multiplicity')??null;
    if(sourceRoute&&method&&basis){
      if(!sameHeaderLevel(method,basis,sourceRoute))source.issues.push({code:'fchk-header-route-conflict',message:'FCHK头部方法/基组/限制性与完整Route冲突；不能静默选择其中一套。请核对来源。',field:'method',severity:'conflict'});
    }
    source.files={geometry:'explicit',guessRead:false,readCheckpoint:false,oldCheckpoint:'',basisFromCheckpoint:false};
    if(!sourceRoute)source.issues.push({code:'fchk-route-missing',message:'FCHK未含完整Route，头信息只能恢复方法/基组；色散、溶剂、SCF/积分和任务细节未确认。',field:'route',severity:'missing'});
    source.issues.push({code:'fchk-not-chk',message:'FCHK不是二进制CHK；不自动写%oldchk/Guess=Read/RCFC，不将MicOpt或力常数数组推定为冻结/兼容Hessian。',field:'files',severity:'warning'});
    for(const warning of [...new Set(this.warnings)])source.issues.push({code:'fchk-truncated',message:warning,field:'route',severity:'warning'});
    const nuclear=this.arrays.get('Nuclear charges');if(nuclear&&nuclear.some((z,i)=>Math.abs(z-zs[i])>1e-6)&&!source.routeOverrides.basisTail)source.issues.push({code:'fchk-ecp',message:'FCHK有效核电荷提示ECP；没有完整基组/ECP附加段，不能仅凭头名称重建所有赝势设置。',field:'basis',severity:'missing'});
    const structure:Structure={id:name+'-0',name,format:'FCH / FCHK',atoms,charge:this.scalars.get('Charge')??null,multiplicity:this.scalars.get('Multiplicity')??null,dimension:3,sourceRoute:route||undefined,gaussianSource:source,notes:['FCHK的Bohr坐标已转换为Å；流式跳过波函数大数组，继续读取尾部Route元数据。','FCHK不直接替代CHK；缺失冻结/路由设置需在继承时核对。',...(methodModifier?[`FCHK原始头部：${this.header}`]:[])]};
    return [structure];
  }
}
