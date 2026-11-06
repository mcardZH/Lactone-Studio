'use strict';
// Window leases transport UI only. Scientific state and IPC authority stay in
// the opener; about:blank children are never registered as desktop IPC owners.
const {randomUUID}=require('node:crypto');
const {assert,plain,string}=require('./security.cjs');
const EVENT_CHANNEL='sciyue:analysis-window-event';
const alive=window=>window&&!window.isDestroyed()&&!window.webContents.isDestroyed();
function placement(value){
  if(value===undefined)return{};
  assert(plain(value)&&Object.keys(value).every(key=>['x','y','width','height'].includes(key)),'Invalid analysis window placement');
  for(const [key,number]of Object.entries(value))assert(Number.isSafeInteger(number)&&(key==='x'||key==='y'?Math.abs(number)<=100000:number>=(key==='width'?320:240)&&number<=4000),'Analysis window placement exceeds bounds');
  return{...value};
}
function createAnalysisWindowHost({sendToOwner,headless=false,icon,now=Date.now,uuid=randomUUID,leaseMs=30000,maxPerOwner=16}={}){
  assert(typeof sendToOwner==='function','Analysis window event delivery required');
  const owners=new Map(),leases=new Map(),targets=new Map();let seq=0;
  // Electron's native parent relation also couples minimization on Windows.
  // Keep these as independent top-level windows, and restore only their local
  // z-order when their own opener is activated. No global always-on-top flag,
  // polling, show/restore, or focus stealing is involved.
  function stackOwnerChildren(owner){
    const parent=owners.get(owner);if(!alive(parent)||parent.isMinimized?.())return;
    let below=parent.getMediaSourceId?.();if(!below)return;
    for(const record of leases.values())if(record.owner===owner&&alive(record.child)&&!record.child.isMinimized?.()&&record.child.isVisible?.()!==false){
      try{record.child.moveAbove(below);below=record.child.getMediaSourceId?.()??below;}catch{/* A closing native window can disappear between checks. */}
    }
  }
  const bounds=child=>{const value=child.getBounds?.();return value&&['x','y','width','height'].every(key=>Number.isSafeInteger(value[key]))?{x:value.x,y:value.y,width:value.width,height:value.height}:undefined;};
  function emit(record,kind,extra={}){if(!alive(owners.get(record.owner)))return;try{sendToOwner(record.owner,{leaseId:record.leaseId,instanceId:record.instanceId,kind,seq:++seq,...extra});}catch{/* A closed opener cannot receive UI notifications. */}}
  function forget(record,reason){
    if(leases.get(record.leaseId)!==record)return;
    clearTimeout(record.timer);leases.delete(record.leaseId);targets.delete(record.target);emit(record,'closed',{reason});
  }
  function close(record,reason){record.reason=reason;if(alive(record.child))record.child.destroy();forget(record,reason);}
  function closeOwnerLeases(owner){for(const record of [...leases.values()])if(record.owner===owner)close(record,'owner-closed');}
  function disposeOwner(owner){closeOwnerLeases(owner);owners.delete(owner);}
  function bind(owner,child,details){
    const record=targets.get(details?.frameName);
    if(!record||record.owner!==owner||record.state!=='opening'||details.url!=='about:blank'||!alive(owners.get(owner))){child.destroy();return;}
    const preferences=child.webContents.getLastWebPreferences?.();
    if(preferences&&(preferences.nodeIntegration!==false||preferences.contextIsolation!==true||preferences.sandbox!==true)){child.destroy();forget(record,'unsafe-child');return;}
    clearTimeout(record.timer);record.child=child;record.state='open';
    child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    for(const name of ['will-navigate','will-frame-navigate','will-redirect','will-attach-webview'])child.webContents.on(name,event=>event.preventDefault());
    child.webContents.on('render-process-gone',()=>close(record,'renderer-gone'));
    child.once('closed',()=>forget(record,record.reason??'user'));
    child.on('focus',()=>emit(record,'focus'));child.on('blur',()=>emit(record,'blur'));
    child.on('restore',()=>{if(owners.get(owner)?.isFocused?.())stackOwnerChildren(owner);});
    for(const name of ['move','resize'])child.on(name,()=>emit(record,'geometry',{bounds:bounds(child)}));
    emit(record,'opened',{bounds:bounds(child)});
    if(owners.get(owner)?.isFocused?.())stackOwnerChildren(owner);
  }
  function attachOwner(window){
    const owner=window.webContents.id;assert(!owners.has(owner),'Analysis opener already attached');owners.set(owner,window);
    window.webContents.setWindowOpenHandler(details=>{
      const record=targets.get(details.frameName);
      if(!alive(window)||!record||record.owner!==owner||record.state!=='prepared'||record.expiresAt<=now()||details.url!=='about:blank'||(details.features??'')!==''||details.postBody!=null)return{action:'deny'};
      record.state='opening';
      return{action:'allow',outlivesOpener:false,overrideBrowserWindowOptions:{...(icon?{icon}:{}),width:480,height:620,minWidth:320,minHeight:240,...record.bounds,title:record.title,show:!headless,autoHideMenuBar:true,fullscreenable:false,alwaysOnTop:false,modal:false,minimizable:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false}}};
    });
    window.webContents.on('did-create-window',(child,details)=>bind(owner,child,details));
    window.on('focus',()=>stackOwnerChildren(owner));
    window.webContents.on('render-process-gone',()=>disposeOwner(owner));
    window.webContents.on('did-start-navigation',(event,_url,_inPlace,isMainFrame)=>{if((typeof isMainFrame==='boolean'?isMainFrame:event.isMainFrame)!==false)closeOwnerLeases(owner);});
    window.once('closed',()=>disposeOwner(owner));
  }
  function prepare(owner,request){
    assert(alive(owners.get(owner)),'Analysis opener unavailable');
    assert(plain(request)&&Object.keys(request).every(key=>['instanceId','title','bounds'].includes(key))&&string(request.instanceId,128)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(request.instanceId)&&string(request.title,160),'Invalid analysis window request');
    for(const record of [...leases.values()])if(record.owner===owner&&record.state==='prepared'&&record.expiresAt<=now())close(record,'expired');
    const owned=[...leases.values()].filter(record=>record.owner===owner);
    assert(!owned.some(record=>record.instanceId===request.instanceId),'Analysis instance already detached');
    assert(owned.length<maxPerOwner,'最多同时打开16个独立分析窗口，请先停靠或关闭已有窗口。');
    const leaseId=uuid(),target='sciyue-analysis-'+leaseId;assert(!leases.has(leaseId)&&!targets.has(target),'Duplicate analysis lease');
    const record={owner,instanceId:request.instanceId,title:request.title,bounds:placement(request.bounds),leaseId,target,expiresAt:now()+leaseMs,state:'prepared'};
    record.timer=setTimeout(()=>{if(record.state!=='open')close(record,'expired');},leaseMs);record.timer.unref?.();leases.set(leaseId,record);targets.set(target,record);
    return{leaseId,target,instanceId:record.instanceId,expiresAt:record.expiresAt};
  }
  function release(owner,request){
    assert(plain(request)&&Object.keys(request).length===1&&string(request.leaseId,128),'Invalid analysis window release');
    const record=leases.get(request.leaseId);if(!record)return{closed:false};assert(record.owner===owner,'Analysis window belongs to another owner');close(record,'released');return{closed:true};
  }
  return{attachOwner,prepare,release,disposeOwner,dispose(){for(const owner of [...owners.keys()])disposeOwner(owner);},count:()=>leases.size};
}
module.exports={createAnalysisWindowHost,EVENT_CHANNEL};
