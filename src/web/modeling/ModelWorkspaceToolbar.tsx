import {useRef,useState,type ReactNode} from 'react';
import type {DisplaySettings} from '../../modeling/contracts';
import type {Atom} from '../../core/types';
import ModelViewToolbar,{type ModelViewToolbarProps} from './ModelViewToolbar';
import ModelSettingsPopover from './ModelSettingsPopover';
import {useTransientLayer} from '../TransientLayer';
import './model-workspace-toolbar.css';

export interface ModelWorkspaceToolbarProps {
  display:DisplaySettings;
  onDisplayChange(display:DisplaySettings):void;
  view:ModelViewToolbarProps;
  onNew?():void;
  onImport?():void;
  onOpenStructureLibrary?():void;
  /** One shared image export menu immediately after Import. Its owner supplies capture. */
  imageExport?:ReactNode;
  onSave?():void;
  onOpen2D?():void;
  onUndo?():void;
  onRedo?():void;
  disabled?:Partial<Record<'new'|'import'|'save'|'open2D'|'undo'|'redo',boolean>>;
  readOnly?:boolean;
  /** Observation hosts retain shared display controls without project/editor flows. */
  observationOnly?:boolean;
  /** Temporary transform previews can lock source editing without locking
   * workspace history. Omission preserves the normal readonly boundary. */
  historyReadOnly?:boolean;
  layoutActions?:ReactNode;
  /** Result-only measurement/export etc.; never a second common toolbar. */
  actions?:ReactNode;
  settingsContent?:ReactNode;
  onOpenSettings?():void;
  atoms?:readonly Atom[];targetLabel?:string;hasCell?:boolean;showAxes?:boolean;onShowAxesChange?(value:boolean):void;
  onActivate?():void;
}

/** One presentation for editable and read-only viewports. All state and
 * commands stay with the owner; this component creates no Store or camera. */
export default function ModelWorkspaceToolbar(p:ModelWorkspaceToolbarProps){
  const [saveMenu,setSaveMenu]=useState(false),saveTrigger=useRef<HTMLButtonElement>(null),savePopup=useRef<HTMLDivElement>(null);
  useTransientLayer({open:saveMenu,triggerRef:saveTrigger,contentRef:savePopup,onDismiss:()=>setSaveMenu(false)});
  const projectMode=typeof window!=='undefined'&&Boolean(window.sciyueDesktop?.syProject);
  const projectAction=(action:'save'|'save-as'|'open')=>{setSaveMenu(false);if(window.sciyueDesktop?.requestProjectAction)void window.sciyueDesktop.requestProjectAction(action);else window.dispatchEvent(new CustomEvent('sciyue-project-action',{detail:action}));};
  const disabled=(action:keyof NonNullable<ModelWorkspaceToolbarProps['disabled']>,callback:unknown)=>!callback||Boolean(p.disabled?.[action])||Boolean(['undo','redo'].includes(action)?p.historyReadOnly??p.readOnly:p.readOnly&&['save','open2D'].includes(action));
  return <header className="model-workspace-heading model-workspace-toolbar" data-testid="model-shared-toolbar" data-read-only={Boolean(p.readOnly)} data-observation-only={Boolean(p.observationOnly)} onPointerDownCapture={p.onActivate}>
    <div className="model-workspace-heading-left">
      {!p.observationOnly&&<>{p.onNew&&<button type="button" disabled={disabled('new',p.onNew)} onClick={p.onNew}>新建</button>}
      <button type="button" disabled={disabled('import',p.onImport)} data-testid="model-import" onClick={p.onImport}>导入</button>
      {p.onOpenStructureLibrary&&<button type="button" data-testid="model-structure-library" onClick={p.onOpenStructureLibrary}>结构库</button>}</>}
      {p.imageExport}
      {!p.observationOnly&&<><span className="model-project-save"><button ref={saveTrigger} type="button" disabled={projectMode?false:disabled('save',p.onSave)} data-testid="model-save" aria-expanded={saveMenu} onClick={()=>projectMode?setSaveMenu(value=>!value):p.onSave?.()}>保存…</button>{saveMenu&&<div ref={savePopup} className="model-project-save-menu" role="menu" aria-label="保存方式"><button role="menuitem" onClick={()=>projectAction('save')}>保存项目…</button><button role="menuitem" onClick={()=>projectAction('save-as')}>项目另存为…</button><button role="menuitem" disabled={disabled('save',p.onSave)} onClick={()=>{setSaveMenu(false);p.onSave?.();}}>导出结构文件…</button></div>}</span>
      <button type="button" disabled={disabled('open2D',p.onOpen2D)} data-testid="model-open-2d" onClick={p.onOpen2D}>二维绘图</button>
      {p.layoutActions}</>}
    </div>
    <div className="model-workspace-heading-right">
      {!p.observationOnly&&<><button type="button" data-testid="builder-undo" aria-label="撤销建模" title="撤销建模" disabled={disabled('undo',p.onUndo)} onClick={p.onUndo}>↶</button>
      <button type="button" data-testid="builder-redo" aria-label="重做建模" title="重做建模" disabled={disabled('redo',p.onRedo)} onClick={p.onRedo}>↷</button></>}
      <ModelViewToolbar {...p.view}/>
      <ModelSettingsPopover display={p.display} onDisplayChange={p.onDisplayChange} onOpenSettings={p.onOpenSettings} atoms={p.atoms} targetLabel={p.targetLabel} hasCell={p.hasCell} showAxes={p.showAxes??p.view.showAxes} onShowAxesChange={p.onShowAxesChange??(()=>p.view.onToggleAxes())}>{p.settingsContent}</ModelSettingsPopover>
    </div>
    {p.actions&&<div className="model-workspace-toolbar-actions" data-testid="model-toolbar-actions">{p.actions}</div>}
  </header>;
}
