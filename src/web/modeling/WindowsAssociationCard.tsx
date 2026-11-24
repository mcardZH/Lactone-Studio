import {useEffect,useRef,useState} from 'react';
import {invokeProject,type SyProjectInvoke,type WindowsAssociationStatus} from '../../projects/desktop-bridge';
import {DismissibleNotice} from '../DismissibleNotice';
import {InputSettingsAction} from '../InputSettingsLayout';

const labels:Record<WindowsAssociationStatus['state'],string>={unsupported:'当前系统不支持',unregistered:'未注册',registered:'已注册','update-needed':'程序路径需要更新',partial:'部分完成'};
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
  const summary=busy?'正在读取或更新…':error?'关联读取或更新失败':status?labels[status.state]:'尚未读取';
  return <section className="sy-settings-card sy-windows-association" aria-label="Windows 文件关联">
    <details className="settings-tool-disclosure">
      <summary className="settings-tool-row">
        <strong className="settings-tool-title">Windows 文件关联</strong>
        <output className="settings-tool-status" data-state={error?'error':status?.state==='registered'&&!busy?'ready':undefined}>{summary}</output>
        <span className="settings-tool-reveal" aria-hidden="true"><span>管理</span><span>收起</span></span>
      </summary>
      <div className="settings-tool-detail">
        <div className="settings-tool-actions">
          <InputSettingsAction variant="primary" disabled={busy||!status?.supported} onClick={()=>void change('association-register')}>注册 / 更新当前路径</InputSettingsAction>
          <InputSettingsAction variant="surface" disabled={busy||!status?.supported||status.state==='unregistered'} onClick={()=>void change('association-remove')}>移除本程序关联</InputSettingsAction>
        </div>
        {status?.operation&&<p role="status">本次{status.operation==='remove'?'移除':'注册 / 更新'} {status.changedCount??0} 项{status.retainedCount!==undefined&&`，保留原设置 ${status.retainedCount} 项`}。</p>}
        {status?.executablePath&&<div className="settings-tool-file"><strong>当前程序</strong><code>{status.executablePath}</code></div>}
        {status?.registeredExecutablePath&&<div className="settings-tool-file"><strong>已注册程序</strong><code>{status.registeredExecutablePath}</code></div>}
        {status?.state==='update-needed'&&<p>便携目录已变更，请更新到当前程序路径。</p>}
        {status?.issues.length ? <details>
          <summary>逐项诊断（{status.issues.length}）</summary>
          <p>已完成的设置已记录，可再次注册 / 更新或移除。</p>
          <ul className="settings-association-issues">{status.issues.map((issue,index)=><li key={`${issue.code}:${issue.target}:${index}`}>
            <span>{issue.message}</span><code>{issue.target}</code><code>{issue.code}</code>
          </li>)}</ul>
        </details> : null}
        {status?.supported&&<details>
          <summary>支持的格式与打开方式</summary>
          <p className="settings-association-extensions">{status.extensions.map(extension=><code key={extension}>{extension}</code>)}</p>
          <p>将 Ester Studio 加入 Windows「打开方式」。默认打开程序由您在 Windows 中选择，文件内容由原有导入入口识别。</p>
          <p><code>.com</code> 是 Windows 命令文件。请右键选择「打开方式」并使用 Ester Studio 读取，Windows 保留该文件的默认执行方式。无扩展名 POSCAR 请在程序内打开。需要配套文件时，请在程序内一起选择或拖入。</p>
        </details>}
      </div>
    </details>
    {error&&<DismissibleNotice role="alert">{error} 切换到其他设置页再返回可刷新状态。</DismissibleNotice>}
  </section>;
}
