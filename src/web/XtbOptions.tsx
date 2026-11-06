import {DismissibleNotice} from './DismissibleNotice';
import { useMemo,useState } from 'react';
import { Download,FileCode2,Info,Upload } from 'lucide-react';
import type { XtbSettings } from '../core/types';
import { defaultXtb,patchXtbScript } from '../core/xtb';
export default function XtbOptions({settings,onChange}:{settings:XtbSettings|undefined;onChange:(settings:XtbSettings)=>void}){
  const current=settings??defaultXtb();const [source,setSource]=useState(''),[name,setName]=useState(''),[loadError,setLoadError]=useState('');
  const patched=useMemo(()=>{if(!source)return null;try{return {result:patchXtbScript(source,current),error:''};}catch(error){return {result:null,error:(error as Error).message};}},[source,current]);
  function update<K extends keyof XtbSettings>(key:K,value:XtbSettings[K]){onChange({...current,[key]:value,...(key==='scriptConfirmed'?{}:{scriptConfirmed:false})});}
  function download(){if(!patched?.result)return;const url=URL.createObjectURL(new Blob([patched.result.text],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=current.scriptPath.split('/').at(-1)||'xtb.sh';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <section className="xtb-options task-specific" data-field="xtb-options" tabIndex={-1}><div className="subheading"><h3><FileCode2 size={15}/>Gaussian挂接xTB</h3><span className="field-caption">默认GFN2；不部署、不运行</span></div>
    <div className="task-notice"><strong>Gaussian控制几何，xTB提供能量和导数</strong><p>Gaussian固定单核，不写CHK/oldchk/Guess/RCFC。实际xTB线程沿原脚本，不等于整个任务只占1核。电荷/自旋仍由原脚本从GJF读取，不另加--chrg/--uhf。</p></div>
    <label className="field">GJF中的External脚本路径<input aria-label="External脚本路径" value={current.scriptPath} onChange={event=>update('scriptPath',event.target.value)} placeholder="./xtb.sh"/><small>运行环境中的Linux路径，不是本机文件选择框；每个作业需独立目录。</small></label>
    <div className="two-fields"><label className="field">xTB可执行路径<input aria-label="xTB可执行路径" value={current.executable} onChange={event=>update('executable',event.target.value)}/></label><label className="field">接口计算级别<input aria-label="xTB计算级别" value={current.level} onChange={event=>update('level',event.target.value)} placeholder="--gfn 2 --gbsa water"/><small>例如--gfn 2或--gfn 2 --gbsa water；溶剂在脚本中设置，GJF不加SCRF。ALPB需xTB≥6.3.3。</small></label></div>
    <label className="option-explanation"><input type="checkbox" checked={current.entryBasis} onChange={event=>update('entryBasis',event.target.checked)}/><span><strong>仅处理Gaussian入口元素检查时加UGBS</strong><small>默认不加；这是入口兼容手段，不改变xTB方法，也不补齐xTB缺少的元素参数。</small></span></label>
    <details className="local-forcefield"><summary>上传原挂接脚本 · 仅修改允许的四行</summary><p className="muted-note">可选：仅生成GJF可引用已有接口；需要生成匹配脚本时上传原xtb.sh。不内置重写版，不打包genxyz/extderi。</p><label className="button button-white script-upload"><Upload size={14}/>选择原xtb.sh<input aria-label="挂接脚本原文件" type="file" accept=".sh,text/plain" onChange={async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>1024*1024)throw new Error('脚本超过1MB。');let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());}catch{throw new Error('脚本不是有效UTF-8；请先转换源文件，本页不静默替换字符。');}patchXtbScript(text,current);setSource(text);setName(file.name);setLoadError('');update('scriptConfirmed',false);}catch(error){setLoadError((error as Error).message);}}}/></label>
      {name&&<p className="muted-note">原文件：{name}；只在浏览器内读取，不修改原件。</p>}
      {(loadError||patched?.error)&&<DismissibleNotice className="inline-selection-error" role="alert"><Info size={13}/>{loadError||patched?.error}</DismissibleNotice>}
      {patched?.result&&!loadError&&<><p className="muted-note">识别到梯度/Hessian分支；改变{patched.result.changes.length}行，其余内容逐字保留。不认证未知脚本的其余逻辑。</p>{patched.result.threads.map(line=><code className="script-thread" key={line}>{line}（原样保留）</code>)}<pre className="script-diff" aria-label="挂接脚本修改预览">{patched.result.changes.length?patched.result.changes.map(change=>'行'+change.line+'\n- '+change.before+'\n+ '+change.after).join('\n\n'):'路径/级别已一致，无内容改动。'}</pre><button className="button button-white" onClick={download}><Download size={14}/>下载匹配的挂接脚本</button></>}
    </details>
    <p className="muted-note">运行目录还须已有可执行genxyz/extderi、xTB和bc；固定临时文件要求一目录一个Gaussian进程。沿接口80字符文件名限制使用短GAUSS_SCRDIR；网页不检查服务器文件、权限或线程额度。</p>
    <label className="check-line"><input data-field="xtb-confirmation" type="checkbox" checked={current.scriptConfirmed} onChange={event=>update('scriptConfirmed',event.target.checked)}/><span>我已核对运行环境的脚本路径、两分支计算级别/溶剂一致、依赖与线程额度；这里不是远端验证回执。</span></label>
  </section>;
}
