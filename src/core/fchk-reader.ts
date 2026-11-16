import { elementSymbol } from './elements';
import { BASES, METHODS, canonicalBasis } from './catalog';
import { gaussianRouteTokens, parseGaussianSource } from './gaussian-source';
import type { Structure } from './types';
import { fchkCharacterRecord, fchkField, fchkNumericRecordTokens, type FchkFieldDiagnostic } from './fchk-records';

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
export interface FchkTrackedField {
  /** Appended [] distinguishes an array from a scalar. */
  shape: 'I' | 'R' | 'I[]' | 'R[]' | 'C[]';
  retainValues?: boolean;
}
export interface FchkValidatedField {
  sourceLine: number;
  count: number;
  values: readonly number[];
}
export const fchkGeometryFields = {
  'Number of atoms': { shape: 'I' },
  'Atomic numbers': { shape: 'I[]' },
  'Current cartesian coordinates': { shape: 'R[]' },
} as const satisfies Readonly<Record<string, FchkTrackedField>>;
const geometryFields=new Set(['Atomic numbers','Current cartesian coordinates','Nuclear charges','Real atomic weights','Route','Full Title']);
const uniqueGeometryFields=new Set([...geometryFields,'Number of atoms','Charge','Multiplicity']);

/** Keeps geometry and small metadata, validates MO/density arrays without retaining their contents. */
export class FchkReader {
  private line=0;private title='';private header='';private scalars=new Map<string,number>();private arrays=new Map<string,number[]>();private chars=new Map<string,string>();
  private active:{label:string;type:string;count:number;remaining:number;capture:boolean;values:number[];text:string;sourceLine:number;damaged:boolean}|null=null;
  private seen=new Set<string>();private invalid=new Set<string>();
  readonly diagnostics:FchkFieldDiagnostic[]=[];
  readonly validatedFields=new Map<string,FchkValidatedField>();
  constructor(private readonly track:Readonly<Record<string,FchkTrackedField>>={}){}
  private requiredGeometry(label:string):boolean{return ['Atomic numbers','Current cartesian coordinates'].includes(label);}
  get incomplete():boolean{return this.diagnostics.length>0;}
  private tracked(label:string):FchkTrackedField|undefined{return Object.hasOwn(this.track,label)?this.track[label]:undefined;}
  private damage(field:string,code:FchkFieldDiagnostic['code'],message:string,sourceLine:number,boundaryReliable=true):void{
    const affectedCapabilities:FchkFieldDiagnostic['affectedCapabilities']=
      !boundaryReliable||this.tracked(field)?['wavefunction']:field==='Real atomic weights'?['atomic-masses']:['saved-field'];
    this.diagnostics.push({field,sourceLine,code,boundaryReliable,affectedCapabilities,message:`FCHK ${field} ${message}（源行 ${sourceLine}）。`});
  }
  private truncate(interrupted=false):void{
    const active=this.active!;
    if(this.requiredGeometry(active.label))throw new Error(`FCHK的${active.label}截断。`);
    const character=active.type==='C'||active.type==='H';
    if(character&&!interrupted)throw new Error(`FCHK ${active.label}字符数组截断。`);
    this.damage(active.label,'truncated',character?'字符数组未满声明长度':'数组未满声明长度',active.sourceLine,!character);
    this.active=null;
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
    const field=fchkField(line);
    if(field){
      if(this.active?.remaining)this.truncate();
      const {label,type,count,token}=field;
      if(count===undefined&&token?.startsWith('N=')){
        this.damage(label,'untrusted-boundary','数组长度声明无效',this.line,false);
        return;
      }
      const tracked=this.tracked(label);
      if(this.seen.has(label)&&(uniqueGeometryFields.has(label)||tracked)){
        if(this.requiredGeometry(label)||label==='Number of atoms')throw new Error(`FCHK字段 ${label} 重复。`);
        this.invalid.add(label);this.scalars.delete(label);this.arrays.delete(label);this.chars.delete(label);this.validatedFields.delete(label);
        this.damage(label,'duplicate','字段重复，未采用歧义值',this.line);
      }
      this.seen.add(label);
      const wrongType=tracked&&tracked.shape!==(count===undefined?type:`${type}[]`);
      if(wrongType)this.damage(label,'invalid-type',`字段类型或记录形状无效，应为 ${tracked.shape}`,this.line);
      if(count!==undefined){
        if(!Number.isSafeInteger(count)||count<0){
          if(this.requiredGeometry(label))throw new Error('FCHK数组长度声明无效。');
          this.damage(label,'untrusted-boundary','数组长度声明无效',this.line,false);
          return;
        }
        const capture=!wrongType&&(geometryFields.has(label)||!!tracked?.retainValues);
        this.active={label,type,count,remaining:count,capture,values:[],text:'',sourceLine:this.line,damaged:!!wrongType};
        if(!count)this.complete();
      }else if(['I','R'].includes(type)){
        const value=fchkNumber(token!);
        if(value===null||(type==='I'||['Charge','Multiplicity'].includes(label))&&!Number.isSafeInteger(value)){
          if(label==='Number of atoms')throw new Error(`FCHK标量 ${label} 含无效数据。`);
          this.damage(label,'invalid-number','标量含无效数值',this.line);return;
        }
        if(label==='Multiplicity'&&value<1){this.damage(label,'invalid-number','多重度无效',this.line);return;}
        if(!wrongType&&!this.invalid.has(label)){
          this.scalars.set(label,value);
          if(tracked)this.validatedFields.set(label,{sourceLine:this.line,count:1,values:[value]});
        }
      }
      return;
    }
    if(!this.active){
      if(line.trim()&&!this.diagnostics.some(diagnostic=>!diagnostic.boundaryReliable))this.damage('记录','untrusted-boundary','出现未归属字段或续行',this.line,false);
      return;
    }
    const active=this.active;
    if(line.includes('N=')&&/^\s*\S.*\s+[A-Z]\s+N=/.test(line)){
      this.damage(active.label,'untrusted-boundary','出现无法识别的数组记录声明',this.line,false);
      this.active=null;return;
    }
    const tokens=fchkNumericRecordTokens(line,active.type);
    if(!tokens.length)return;
    if(tokens.length>active.remaining){
      if(this.requiredGeometry(active.label))throw new Error(`FCHK的${active.label}包含额外数值。`);
      this.damage(active.label,'untrusted-boundary','数值超过声明长度',active.sourceLine,false);
      this.active=null;return;
    }
    if(!active.damaged)for(const token of tokens){
      const value=active.type==='L'?null:fchkNumber(token);
      const valid=active.type==='L'?/^[TF]$/.test(token):value!==null&&(active.type!=='I'||Number.isSafeInteger(value));
      if(!valid){
        if(this.requiredGeometry(active.label))throw new Error(`FCHK数组 ${active.label} 含无效数据。`);
        this.damage(active.label,'invalid-number',active.type==='I'?'字段含无效整数':'字段含无效数值',active.sourceLine);
        active.damaged=true;break;
      }
      if(active.capture)active.values.push(value!);
    }
    active.remaining-=tokens.length;
    if(!active.remaining)this.complete();
  }
  private complete(){
    const active=this.active!;
    if(!active.damaged&&!this.invalid.has(active.label)){
      if(active.capture){
        if(active.type==='C'||active.type==='H')this.chars.set(active.label,active.text.trimEnd());
        else if(geometryFields.has(active.label))this.arrays.set(active.label,active.values);
      }
      if(this.tracked(active.label))this.validatedFields.set(active.label,{sourceLine:active.sourceLine,count:active.count,values:active.values});
    }
    this.active=null;
  }
  finish(name:string,interrupted=false):Structure[]{
    if(this.active?.remaining)this.truncate(interrupted);
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
    for(const diagnostic of this.diagnostics)source.issues.push({code:'fchk-truncated',message:diagnostic.message,field:'route',severity:'warning'});
    const nuclear=this.arrays.get('Nuclear charges');if(nuclear&&nuclear.some((z,i)=>Math.abs(z-zs[i])>1e-6)&&!source.routeOverrides.basisTail)source.issues.push({code:'fchk-ecp',message:'FCHK有效核电荷提示ECP；没有完整基组/ECP附加段，不能仅凭头名称重建所有赝势设置。',field:'basis',severity:'missing'});
    const structure:Structure={id:name+'-0',name,format:'FCH / FCHK',atoms,charge:this.scalars.get('Charge')??null,multiplicity:this.scalars.get('Multiplicity')??null,dimension:3,sourceRoute:route||undefined,gaussianSource:source,notes:['FCHK的Bohr坐标已转换为Å；流式跳过波函数大数组，继续读取尾部Route元数据。','FCHK不直接替代CHK；缺失冻结/路由设置需在继承时核对。',...(methodModifier?[`FCHK原始头部：${this.header}`]:[])]};
    return [structure];
  }
}
