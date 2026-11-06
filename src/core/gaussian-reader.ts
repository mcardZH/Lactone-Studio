import { elementSymbol } from './elements';
import { OrcaOutputReader } from './orca-readers';
import { outputSoftwareOnLine, recognizeSourceText } from '../results/source-recognition';
import type { Atom,Structure } from './types';
import { applyGaussianLink0, applyGaussianTail, normalizeGaussianRouteEcho,parseGaussianSource, type GaussianSourceMeta } from './gaussian-source';
import { GaussianOutputArchive,GaussianOutputTitle } from '../results/gaussian-output-archive';

const separator=/^\s*-{5,}\s*$/;
/** Geometry-only streaming reader. A complete frame is not a scientific acceptance. */
export class GaussianOutputReader {
  private stage=0;private header='';private rows:Atom[]=[];private bad=false;
  private last:Atom[]|null=null;private expected:number|null=null;private truncated=false;
  private charge:number|null=null;private multiplicity:number|null=null;
  private stationary=false;private normal=false;private failed=false;private frequency=false;private frequencySeen=false;
  private route='';private printedRoute='';private capturingRoute=false;private seen=false;
  private source:GaussianSourceMeta|null=null;private jobIndex=0;private jobs:Structure[]=[];private link0:string[]=[];
  private echoAtoms=0;private echoFrozen:number[]=[];private echoActive=false;private tailLines:string[]=[];private readingTail=false;private expectedTail=false;
  private outputArchive=new GaussianOutputArchive();
  private outputTitle=new GaussianOutputTitle<{text:string}>();
  private reset(){this.stage=0;this.rows=[];this.last=null;this.expected=null;this.truncated=false;this.charge=null;this.multiplicity=null;this.stationary=false;this.normal=false;this.failed=false;this.frequency=false;this.frequencySeen=false;this.route='';this.printedRoute='';this.capturingRoute=false;}
  consume(line:string){
    const filtered=this.outputTitle.consume({text:line});
    if(filtered.title?.length&&this.source)this.source.title=filtered.title.map(row=>row.text).join('\n').trim();
    for(const row of filtered.lines)this.consumeOutput(row.text);
  }
  private consumeOutput(line:string){
    if(this.outputArchive.consume(line))return;
    const subsequentInitialCommand=/^\s*Initial command:\s*$/.test(line)&&Boolean(this.last||this.route||this.charge!==null||this.failed||this.normal);
    if(/Entering Gaussian System|Link1:.*Proceeding to internal job step/.test(line)||subsequentInitialCommand){if(this.seen){this.archive();this.jobIndex++;}this.reset();this.source=null;this.link0=[];this.echoAtoms=0;this.echoFrozen=[];this.echoActive=false;this.tailLines=[];this.readingTail=false;this.expectedTail=false;this.seen=true;}
    if(/Gaussian\s+(?:09|16)\b|Gaussian,\s*Inc\./i.test(line))this.seen=true;
    if(/^\s*%/.test(line)){this.link0.push(line.trim());if(this.link0.length>100)throw new Error('Gaussian Link0记录过多。');}
    // Gaussian IRC prints "# OF STEPS" later; that is not another route section.
    if(!this.route&&/^\s*#[pnt]?(?:\s+|$)/i.test(line)){this.printedRoute=line.trim();this.route=normalizeGaussianRouteEcho(this.printedRoute);this.capturingRoute=true;return;}
    if(this.capturingRoute){if(!line.trim()||separator.test(line)||/^\s*(?:Error termination\b|Normal termination of Gaussian\b|QPErr\s+---)/.test(line)){this.capturingRoute=false;this.source=parseGaussianSource(this.route,'out','',this.jobIndex);applyGaussianLink0(this.source,this.link0);}else{this.printedRoute+='\n'+line.trim();if(this.printedRoute.length>16000)throw new Error('Gaussian路由段过长，未继续读取。');this.route=normalizeGaussianRouteEcho(this.printedRoute);return;}}
    const state=line.match(/Charge\s*=\s*([+-]?\d+)\s+Multiplicity\s*=\s*(\d+)/);
    // Native Counterpoise fragment declarations describe component states;
    // they must not replace/reset the supermolecule's ordinary geometry state.
    if(state&&/\bin\s+fragment\s+\d+\.?\s*$/i.test(line))return;
    if(state){this.stage=0;this.last=null;this.expected=null;this.truncated=false;this.stationary=false;this.normal=false;this.failed=false;this.frequency=false;this.frequencySeen=false;this.echoActive=true;this.echoAtoms=0;this.echoFrozen=[];this.charge=Number(state[1]);this.multiplicity=Number(state[2]);if(!Number.isSafeInteger(this.charge)||!Number.isSafeInteger(this.multiplicity)||this.multiplicity<1)throw new Error('Gaussian电荷/多重度无效。');}
    else if(this.echoActive){
      const explicit=line.match(/^\s*(?:[A-Za-z]{1,2}|\d+)(?:\(Fragment=\d+\))?\s+(?:(-1|0)\s+)?([+-]?[\d.]+(?:[eEdD][+-]?\d+)?)\s+([+-]?[\d.]+(?:[eEdD][+-]?\d+)?)\s+([+-]?[\d.]+(?:[eEdD][+-]?\d+)?)\s*$/);
      if(explicit){this.echoAtoms++;if(explicit[1]==='-1')this.echoFrozen.push(this.echoAtoms);}
      else if(this.echoAtoms||!line.trim()){this.echoActive=false;if(this.echoAtoms&&this.source)this.source.frozenAtoms=[...this.echoFrozen];}
    }
    if(/following ModRedundant input section has been read|ModRedundant input section:/i.test(line)){this.readingTail=true;this.expectedTail=true;this.tailLines=[];return;}
    if(this.readingTail){if(/^\s*[BADX]\s+/i.test(line)){this.tailLines.push(line.trim());return;}if(this.tailLines.length||line.trim()){this.readingTail=false;}}
    const n=line.match(/\bNAtoms\s*=\s*(\d+)/);if(n){this.expected=Number(n[1]);if(!Number.isSafeInteger(this.expected)||this.expected<1)throw new Error('Gaussian原子数须为正安全整数。');}
    if(/Stationary point found|Optimization completed/.test(line))this.stationary=true;
    if(/^\s*Normal termination of Gaussian\b/.test(line))this.normal=true;
    if(/^\s*(?:Error termination\b|Convergence failure\b|Optimization stopped\b|Number of steps exceeded\b)/i.test(line)){this.failed=true;this.normal=false;}
    if(/Harmonic frequencies/i.test(line))this.frequencySeen=true;
    if(/Numerical (?:differentiation|frequencies|calculation of force constants)|Numerically calculating/i.test(line)){if(this.stage)this.truncated=true;this.stage=0;this.frequency=true;this.frequencySeen=true;}
    if(/Point Number\s*:?\s*\d+.*(?:Path Number|path direction)|Step number\s+\d+\s+out of/i.test(line))this.frequency=false;
    if(/^\s*(?:Standard|Input) orientation:\s*$/.test(line)){if(this.stage)this.truncated=true;if(!this.frequency){this.stage=1;this.header='';this.rows=[];this.bad=false;}return;}
    if(!this.stage)return;
    if(separator.test(line)){
      if(this.stage===1){this.stage=2;return;}
      if(this.stage===2){this.bad=!/Center/.test(this.header)||!/Atomic/.test(this.header)||!/Angstroms/i.test(this.header);this.stage=3;return;}
      if(!this.bad&&this.rows.length&&(this.expected===null||this.rows.length===this.expected))this.last=this.rows;else this.truncated=true;
      this.stage=0;return;
    }
    if(this.stage===2){this.header+=' '+line;return;}
    if(this.stage===1){if(line.trim()){this.bad=true;this.truncated=true;this.stage=0;}return;}
    const fields=line.trim().split(/\s+/);
    if(fields.length!==6||!fields.slice(0,3).every(value=>/^[+-]?\d+$/.test(value))){this.bad=true;return;}
    const [center,z,atomicType]=fields.map(Number);if(z<1||z>118||atomicType!==0){this.bad=true;this.truncated=true;return;}
    const numbers=fields.slice(3);const xyz=numbers.map(value=>Number(value.replace(/[dD]/,'e')));
    if(center!==this.rows.length+1||!numbers.every(value=>/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(value))||!xyz.every(Number.isFinite)){this.bad=true;return;}
    this.rows.push({element:elementSymbol(String(z)),x:xyz[0],y:xyz[1],z:xyz[2]});
  }
  finish(name:string):Structure[]{
    for(const row of this.outputTitle.finish())this.consumeOutput(row.text);
    if(this.stage)this.truncated=true;
    if(!this.seen||this.charge===null||this.multiplicity===null||!this.last)throw new Error('当前Gaussian作业/电子态段没有完整普通原子orientation；不跨作业借旧结构。');
    if(this.expected!==null&&this.last.length!==this.expected)throw new Error('Gaussian最后完整帧与当前NAtoms不一致，未返回可能缺失的结构。');
    const source=structuredClone(this.source??parseGaussianSource(this.route,'out',name,this.jobIndex));source.fileName=name;source.id=`${name}:${this.jobIndex}`;source.routeOverrides.sourceId=source.id;
    source.printedRoute=this.printedRoute;
    source.charge=this.charge;source.multiplicity=this.multiplicity;
    if(this.echoActive&&this.echoAtoms)source.frozenAtoms=[...this.echoFrozen];
    if(this.expectedTail){applyGaussianTail(source,this.tailLines.join('\n'),this.last.length,this.last.map(atom=>atom.element));}else if(!/modredundant/i.test(this.route)){source.coordinates=[];}
    if(source.frozenAtoms!==null&&source.coordinates!==null)source.issues=source.issues.filter(i=>i.code!=='constraints-unknown');
    if(source.settings.taskOptions){source.settings.taskOptions.frozenAtoms=source.frozenAtoms??[];source.settings.taskOptions.constraintsEnabled=Boolean(source.frozenAtoms?.length||source.coordinates?.some(c=>c.action==='freeze'));}
    return [{id:name+'-job-'+this.jobIndex,name,format:'Gaussian OUT',atoms:this.last,charge:this.charge,multiplicity:this.multiplicity,dimension:3,sourceRoute:this.route||undefined,gaussianSource:source,notes:[
      '提取本作业/电子态段最后完整Å结构；来源级别和明确回显的冻结可主动继承，未回显数据保持未知。',
      this.normal&&!this.failed?'检测到Gaussian正常终止；不等于电子态或科学结果已验收。':'未检测到当前作业正常终止；仅作恢复几何，不认证收敛。',
      this.stationary?'检测到优化驻点标记；不认证真正TS或唯一目标虚频。':'未检测到优化驻点标记；频率/IRC等任务不能仅据此判失败。',
      ...(this.truncated?['尾帧截断/无效，已回退同一作业/电子态段的较早完整帧。']:[]),
      ...(this.frequencySeen?['检测到频率/数值导数段，未将该段位移结构替代工作几何。']:[]),
      ...(/\bexternal\s*=/i.test(this.route)?['来源使用Gaussian External；实际方法/溶剂需核对接口脚本，不从该路由推定为DFT或GFN2。']:[]),
    ]}];
  }
  private archive(){if(this.last&&this.charge!==null&&this.multiplicity!==null){try{this.jobs.push(...this.finish(''));}catch{/* Invalid current segment is never substituted by an older geometry. */}}}
  finishAll(name:string):Structure[]{
    let current:Structure[]=[];let laterIncomplete=false;try{current=this.finish(name);}catch(error){if(!this.jobs.length)throw error;laterIncomplete=true;}
    return [...this.jobs.map(s=>{const clone=structuredClone(s);clone.name=name;clone.id=`${name}-job-${clone.gaussianSource!.jobIndex}`;clone.gaussianSource!.fileName=name;clone.gaussianSource!.id=`${name}:${clone.gaussianSource!.jobIndex}`;clone.gaussianSource!.routeOverrides.sourceId=clone.gaussianSource!.id;
      if(laterIncomplete){const message=`尾部作业${this.jobIndex+1}无完整结构；仅列较早完整作业，未跨job借帧。当前可选项是作业${clone.gaussianSource!.jobIndex+1}，不是尾部作业的恢复几何。`;clone.notes.push(message);clone.gaussianSource!.issues.push({code:'later-job-incomplete',message,field:'geometry',severity:'warning'});}
      return clone;}),...current];
  }
}

/** Determine the output software from content, never from the shared .out/.log extension. */
export class QuantumOutputReader {
  private reader:GaussianOutputReader|OrcaOutputReader|null=null;private pending:string[]=[];private bytes=0;
  consume(line:string){
    const software=outputSoftwareOnLine(line);
    if(software==='cp2k')throw new Error('识别为CP2K输出，未作为Gaussian/ORCA结构解析。');
    if(this.reader&&software&&(software==='gaussian')!==(this.reader instanceof GaussianOutputReader))throw new Error('来源含不同软件运行身份；未跨软件读取结构。');
    if(this.reader){this.reader.consume(line);return;}
    this.pending.push(line);this.bytes+=line.length;
    if(software==='gaussian')this.reader=new GaussianOutputReader();
    else if(software==='orca')this.reader=new OrcaOutputReader();
    if(this.reader){for(const buffered of this.pending)this.reader.consume(buffered);this.pending=[];}
    else if(this.bytes>1024*1024)throw new Error('输出前1MB未识别Gaussian/ORCA软件标记，未猜测格式。');
  }
  finish(name:string){if(!this.reader)throw new Error('未识别Gaussian/ORCA输出软件；请提供完整文本输出。');return this.reader.finish(name);}
  finishAll(name:string){if(!this.reader)throw new Error('未识别Gaussian/ORCA输出软件；请提供完整文本输出。');return this.reader instanceof GaussianOutputReader?this.reader.finishAll(name):this.reader.finish(name);}
}
export function parseQuantumOutput(text:string,name:string){const identity=recognizeSourceText(text);if(identity.status==='conflict')throw new Error(identity.message);const reader=new QuantumOutputReader();for(const line of text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n'))reader.consume(line);return reader.finish(name);}
