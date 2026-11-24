import {useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import SettingsPanel from '../modeling/SettingsPanel';
import {plotSettingsHosts,type PlotSettingsConnection} from './plot-settings-host';
import './scientific-plot-editing.css';

interface PlotSettingsWindowProps {
  ownerDocument?:Document;
  onClose():void;
  figure:ReactNode;
  sidebar:ReactNode;
  category?:string;
  onKeyDown?(event:KeyboardEvent):void;
}

export function PlotSettingsWindow({ownerDocument,onClose,figure,sidebar,category='line',onKeyDown}:PlotSettingsWindowProps) {
  const owner=ownerDocument??document;
  const close=useRef(onClose);
  close.current=onClose;
  const [target,setTarget]=useState<HTMLElement|null>();
  useLayoutEffect(()=>{
    const host=plotSettingsHosts.get(owner);
    const connection:PlotSettingsConnection={category,close:()=>close.current()};
    setTarget(host?.connect(connection)??null);
    return()=>host?.disconnect(connection);
  },[owner,category]);
  const content=<div className="plot-preset-dialog-body" onKeyDown={onKeyDown}>
    <div className="plot-preset-art">{figure}</div><aside className="plot-preset-fields">{sidebar}</aside>
  </div>;
  if(target)return createPortal(content,target);
  if(target===null)return <SettingsPanel ownerDocument={owner} initialPage="plots" onClose={onClose}
    plotEditor={{category,content}}/>;
  return null;
}

export const VisualizationPresetDialog=PlotSettingsWindow;
