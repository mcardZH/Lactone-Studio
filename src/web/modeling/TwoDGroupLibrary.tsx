import { useState } from 'react';
import { DialogSurface } from '../DialogShell';
import { GROUP_CATEGORIES, GROUP_TEMPLATES, parseLabel, type GroupCategory, type GroupTemplate } from '../../modeling/two-d/editing-templates';

function TemplateStructure({template,large=false}:{template:GroupTemplate;large?:boolean}) {
  const points=template.atoms, a=points[template.attachment];
  const left=Math.min(a.x-1.1,...points.map(p=>p.x))-.37;
  const right=Math.max(...points.map(p=>p.x))+.4;
  const bottom=Math.min(...points.map(p=>-p.y))-.45;
  const top=Math.max(...points.map(p=>-p.y))+.45;
  return <svg className={large?'two-d-group-structure is-large':'two-d-group-structure'} viewBox={`${left} ${bottom} ${right-left} ${top-bottom}`} aria-hidden="true">
    <line x1={a.x-.72} y1={-a.y} x2={a.x} y2={-a.y} stroke="var(--ui-control-selected-stroke,#a8801b)" strokeWidth=".05" strokeDasharray=".12 .08"/>
    <circle data-template-connection="true" cx={a.x-.78} cy={-a.y} r=".085" fill="#a8801b"/>
    {template.bonds.map((b,i)=>{
      const p=points[b.a],q=points[b.b],length=Math.hypot(q.x-p.x,q.y-p.y),dx=(q.y-p.y)/length,dy=(q.x-p.x)/length;
      return Array.from({length:b.order},(_,j)=>{const offset=(j-(b.order-1)/2)*.09;return <line key={`${i}:${j}`} x1={p.x+dx*offset} y1={-p.y+dy*offset} x2={q.x+dx*offset} y2={-q.y+dy*offset} stroke="currentColor" strokeWidth=".052" strokeLinecap="round"/>;});
    })}
    {points.map((p,i)=>{
      if(p.label==='C'&&points.length>1)return null;
      const h=p.attachedHydrogens??0;
      return <text key={i} x={p.x} y={-p.y} dominantBaseline="central" textAnchor="middle" fontSize=".3" fontWeight="600" fill="currentColor" paintOrder="stroke" stroke="white" strokeWidth=".085" strokeLinejoin="round">
        {p.label}{h>0&&<>H{h>1&&<tspan fontSize=".22" baselineShift="sub">{h}</tspan>}</>}{!!p.charge&&<tspan fontSize=".22" baselineShift="super">{Math.abs(p.charge)>1?Math.abs(p.charge):''}{p.charge>0?'+':'−'}</tspan>}
      </text>;
    })}
  </svg>;
}

export default function TwoDGroupLibrary({current,onUse,onClose}:{current:string;onUse(name:string):void;onClose():void}) {
  const [query,setQuery]=useState(''),[category,setCategory]=useState<GroupCategory|'全部'>('全部');
  const [selected,setSelected]=useState(current);
  const search=query.trim().toLowerCase();
  const matches=GROUP_TEMPLATES.filter(t=>(category==='全部'||t.category===category)&&(!search||t.aliases.some(name=>name.toLowerCase().includes(search))));
  const direct=query.trim()?parseLabel(query):null;
  const directTemplate=direct?.ok&&direct.kind==='group'?direct.template:undefined;
  const active=matches.find(t=>t.name===selected)??(directTemplate&&(category==='全部'||directTemplate.category===category)?directTemplate:undefined);
  const q=active?.atoms.reduce((sum,a)=>sum+(a.charge??0),0);
  return <DialogSurface aria-label="基团库" className="two-d-group-library" onCancel={onClose}>
    <div className="two-d-library-heading"><strong>基团库</strong><button type="button" onClick={onClose} aria-label="关闭基团库">×</button></div>
    <div className="two-d-library-filter">
      <label>名称或缩写 <input autoFocus aria-label="搜索基团" value={query} onChange={e=>{setQuery(e.target.value);setSelected('');}}/></label>
      <label>分类 <select aria-label="基团分类" value={category} onChange={e=>{setCategory(e.target.value as typeof category);setSelected('');}}>
        <option>全部</option>{GROUP_CATEGORIES.map(c=><option key={c}>{c}</option>)}
      </select></label>
    </div>
    <div className="two-d-library-main">
      <div className="two-d-library-grid" aria-label="结构模板">
        {matches.map(t=><button type="button" key={t.name} aria-label={t.name} aria-pressed={active?.name===t.name} onClick={()=>setSelected(t.name)}>
          <TemplateStructure template={t}/><span>{t.name}</span>
        </button>)}
        {!matches.length&&!directTemplate&&<p>没有匹配的基团。</p>}
      </div>
      {active&&<div className="two-d-library-preview" aria-label="当前模板预览">
        <strong>{active.name}</strong><TemplateStructure template={active} large/>
        <span>连接点：{active.atoms[active.attachment].label} · 外接单键</span><span>净形式电荷 {q&&q>0?`+${q}`:q}</span>
      </div>}
    </div>
    <div className="two-d-library-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="button button-primary" disabled={!active} onClick={()=>{if(active)onUse(active.name);}}>使用</button></div>
  </DialogSurface>;
}
