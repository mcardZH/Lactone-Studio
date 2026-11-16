import {Component,type ErrorInfo,type ReactNode} from 'react';
import {DismissibleNotice} from '../DismissibleNotice';
import './workspace-render-boundary.css';

interface Props{children:ReactNode;onSave?(asNew:boolean):Promise<boolean>;status?:string;projectName?:string;
  scope?:'workspace'|'document'|'panel';label?:string;resetKey?:unknown;onReturn?():void|Promise<void>;recoveryControls?:ReactNode}
/** Recover presentation only. Project, document and task owners live above this boundary. */
export default class WorkspaceRenderBoundary extends Component<Props,{error:string|null;busy:boolean;saveMessage:string}>{
  state={error:null as string|null,busy:false,saveMessage:''};
  static getDerivedStateFromError(error:unknown){return{error:error instanceof Error?error.message:String(error)};}
  componentDidCatch(error:Error,info:ErrorInfo){
    console.error('[SY_WORKSPACE_RENDER_ERROR]',JSON.stringify({scope:this.props.scope??'workspace',label:this.props.label,message:error.message,stack:error.stack,componentStack:info.componentStack}).slice(0,12000));
  }
  componentDidUpdate(previous:Props){if(previous.resetKey!==this.props.resetKey&&this.state.error)this.setState({error:null,saveMessage:''});}
  private retry=()=>this.setState({error:null,saveMessage:''});
  private returnTo=async()=>{
    if(this.state.busy||!this.props.onReturn)return;
    this.setState({busy:true,saveMessage:''});
    try{await this.props.onReturn();this.setState({error:null,saveMessage:''});}
    catch(error){this.setState({saveMessage:error instanceof Error?error.message:String(error)});}
    finally{this.setState({busy:false});}
  };
  private save=async(asNew:boolean)=>{
    if(this.state.busy||!this.props.onSave)return;
    this.setState({busy:true,saveMessage:''});
    try{const saved=await this.props.onSave(asNew);this.setState({saveMessage:saved?'项目已保存。':'项目未保存；请查看保存提示或选择其他位置。'});}
    catch(error){this.setState({saveMessage:error instanceof Error?error.message:String(error)});}
    finally{this.setState({busy:false});}
  };
  render(){
    if(!this.state.error)return this.props.children;
    const scope=this.props.scope??'workspace';
    return <section className="workspace-render-failure" role="alert" data-testid="workspace-render-failure" data-error-scope={scope}>
      <h2>{scope==='workspace'?'工作区显示异常':scope==='document'?'当前页面显示异常':'当前内容显示异常'}</h2>
      {this.props.label&&<p>{this.props.label}</p>}
      <p>{scope==='workspace'?'项目和任务仍由原工作区保留，可返回模型或重试显示。':'已有数据保留，其他模型和任务可继续使用。'}</p>
      {this.props.projectName&&<p>{this.props.projectName}</p>}
      <div className="workspace-render-failure-actions">
        {this.props.onReturn&&<button type="button" disabled={this.state.busy} onClick={()=>void this.returnTo()}>{scope==='document'?'返回其他模型':'取消并返回模型'}</button>}
        <button type="button" disabled={this.state.busy} onClick={this.retry}>重试显示</button>
        {this.props.onSave&&<><button type="button" disabled={this.state.busy} onClick={()=>void this.save(false)}>保存项目…</button><button type="button" disabled={this.state.busy} onClick={()=>void this.save(true)}>项目另存为…</button></>}
      </div>
      {this.props.recoveryControls}
      {(this.state.saveMessage||this.props.status)&&<p role="status">{this.state.saveMessage||this.props.status}</p>}
      <details><summary>错误详情</summary><DismissibleNotice><pre>{this.state.error}</pre></DismissibleNotice></details>
    </section>;
  }
}
