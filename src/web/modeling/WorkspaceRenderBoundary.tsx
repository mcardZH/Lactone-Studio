import {Component,type ErrorInfo,type ReactNode} from 'react';
import {DismissibleNotice} from '../DismissibleNotice';
import './workspace-render-boundary.css';

interface Props{children:ReactNode;onSave(asNew:boolean):Promise<boolean>;status?:string;projectName?:string}
/** Keep project/registry ownership above a failed presentation subtree. */
export default class WorkspaceRenderBoundary extends Component<Props,{error:string|null;busy:boolean;saveMessage:string}>{
  state={error:null as string|null,busy:false,saveMessage:''};
  static getDerivedStateFromError(error:unknown){return{error:error instanceof Error?error.message:String(error)};}
  componentDidCatch(error:Error,info:ErrorInfo){
    console.error('[SY_WORKSPACE_RENDER_ERROR]',JSON.stringify({message:error.message,stack:error.stack,componentStack:info.componentStack}).slice(0,12000));
  }
  private save=async(asNew:boolean)=>{
    if(this.state.busy)return;
    this.setState({busy:true,saveMessage:''});
    try{const saved=await this.props.onSave(asNew);this.setState({saveMessage:saved?'项目已保存。':'项目未保存；请查看保存提示或选择其他位置。'});}
    catch(error){this.setState({saveMessage:error instanceof Error?error.message:String(error)});}
    finally{this.setState({busy:false});}
  };
  render(){
    if(!this.state.error)return this.props.children;
    return <section className="workspace-render-failure" role="alert" data-testid="workspace-render-failure">
      <h2>工作区显示异常</h2><p>项目数据仍保留在当前工作区。请先保存项目，再退出并重新打开。</p>
      {this.props.projectName&&<p>{this.props.projectName}</p>}
      <div className="workspace-render-failure-actions"><button disabled={this.state.busy} onClick={()=>void this.save(false)}>保存项目…</button><button disabled={this.state.busy} onClick={()=>void this.save(true)}>项目另存为…</button><button disabled={this.state.busy} onClick={()=>window.close()}>退出</button></div>
      <p role="status">{this.state.saveMessage||this.props.status||'File 菜单中的保存与退出仍可使用。'}</p>
      <details><summary>错误详情</summary><DismissibleNotice><pre>{this.state.error}</pre></DismissibleNotice></details>
    </section>;
  }
}
