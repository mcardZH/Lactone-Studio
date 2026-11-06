import {DismissibleNotice} from '../DismissibleNotice';
import {useEffect,useRef,useState} from 'react';
import {invokeProject,type SyProjectInvoke,type WindowsAssociationStatus} from '../../projects/desktop-bridge';

const labels:Record<WindowsAssociationStatus['state'],string>={unsupported:'当前系统不支持',unregistered:'未注册',registered:'已注册', 'update-needed':'程序路径需要更新',partial:'部分完成，需检查下方说明'};
export default function WindowsAssociationCard({invoke,active}:{invoke:SyProjectInvoke;active:boolean}){
  const [status,setStatus]=useState<WindowsAssociationStatus>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[]);
  useEffect(()=>{
    if(!active)return;
    const request=++epoch.current;setBusy(true);setError('');
    void invokeProject(invoke,{action:'association-status'}).then(value=>{if(epoch.current===request)setStatus(value);}).catch(cause=>{if(epoch.current===request)setError(cause instanceof Error?cause.message:String(cause));}).finally(()=>{if(epoch.current===request)setBusy(false);});
    return()=>{epoch.current++;};
  },[invoke,active]);
  async function change(action:'association-register'|'association-remove'){
    const request=++epoch.current;setBusy(true);setError('');
    try{const value=await invokeProject(invoke,{action});if(epoch.current===request)setStatus(value);}
    catch(cause){if(epoch.current===request)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(epoch.current===request)setBusy(false);}
  }
  return <div className="sy-settings-card sy-windows-association" aria-label="Windows 文件关联"><h3>Windows 文件关联</h3>
    <p role="status">{busy?'正在读取或更新关联…':status?`状态：${labels[status.state]}`:'状态：尚未读取'}{!busy&&status?.operation&&`；本次${status.operation==='remove'?'移除':'注册 / 更新'} ${status.changedCount??0} 项`}</p>
    {status?.executablePath&&<p style={{overflowWrap:'anywhere'}}>程序：{status.executablePath}</p>}
    <div className="sy-settings-fields"><button type="button" disabled={busy||!status?.supported} onClick={()=>void change('association-register')}>注册 / 更新当前路径</button><button type="button" disabled={busy||!status?.supported||status.state==='unregistered'} onClick={()=>void change('association-remove')}>移除本程序关联</button></div>
    {status?.supported&&<>
      <p>{`支持：${status.extensions.join('、')}。文件内容仍由原有导入入口识别。`}</p>
      <p>添加 Windows“打开方式”及支持格式信息；保留已有默认程序。包括 .es 项目及兼容的旧 .sy 项目在内，默认打开程序均由您在 Windows 中选择。</p>
      <p>.com 是 Windows 命令文件，请右键“打开方式”明确选择 Ester Studio 读取；不改变默认执行行为。无扩展名 POSCAR 请在程序内打开。</p>
      <p>需要配套文件时，请在程序内一起选择 / 拖入。</p>
      {status.state==='update-needed'&&<p>便携目录已变更，请更新到当前程序路径。</p>}
      {status.issues.length>0&&<><p>部分项目未完成；已完成的设置已记录，可再次注册 / 更新或移除。检测到的其他修改予以保留。</p><ul>{status.issues.map((issue,index)=><li key={`${issue.code}:${issue.target}:${index}`} style={{overflowWrap:'anywhere'}}>{issue.message} {issue.target}</li>)}</ul></>}
    </>}
    {error&&<DismissibleNotice role="alert">{error} 切换到其他设置页再返回可刷新状态。</DismissibleNotice>}
  </div>;
}
