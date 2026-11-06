import type {ScreenPoint} from '../../modeling/contracts';

export interface ResultLabelRect {x:number;y:number;width:number;height:number}
export interface ResultLabelPlacement {rect:ResultLabelRect;leader?:{from:ScreenPoint;to:ScreenPoint};unresolved?:boolean}
export interface ResultLabelLayoutInput {id:string;point:ScreenPoint;anchor:'top-left'|'center';width:number;height:number;target?:ScreenPoint}
export function resultLabelRectsOverlap(a:ResultLabelRect,b:ResultLabelRect,gap=0){return a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y;}
export const RESULT_LABEL_CANDIDATE_LIMIT=96;
/** Fixed candidate budget, independent of how many labels are displayed. */
export function resultLabelCandidates(original:ResultLabelRect,existing:readonly ResultLabelRect[],bounds:{width:number;height:number},gap=6){
 const margin=4,clamp=(rect:ResultLabelRect)=>({...rect,x:Math.min(Math.max(margin,rect.x),Math.max(margin,bounds.width-margin-rect.width)),y:Math.min(Math.max(margin,rect.y),Math.max(margin,bounds.height-margin-rect.height))});
 const candidates=new Map<string,ResultLabelRect>(),add=(x:number,y:number)=>{if(candidates.size>=RESULT_LABEL_CANDIDATE_LIMIT)return;const rect=clamp({...original,x,y});candidates.set(`${rect.x},${rect.y}`,rect);};
 const preferred=clamp(original);add(preferred.x,preferred.y);
 const right=Math.max(margin,bounds.width-margin-original.width),bottom=Math.max(margin,bounds.height-margin-original.height);
 for(const [x,y] of [[margin,preferred.y],[right,preferred.y],[preferred.x,margin],[preferred.x,bottom],[margin,margin],[right,margin],[margin,bottom],[right,bottom]])add(x,y);
 const distance=(rect:ResultLabelRect)=>(rect.x+rect.width/2-original.x-original.width/2)**2+(rect.y+rect.height/2-original.y-original.height/2)**2;
 const nearest=[...existing].sort((a,b)=>distance(a)-distance(b)||a.y-b.y||a.x-b.x).slice(0,12);
 for(const rect of nearest){const left=rect.x-original.width-gap,right=rect.x+rect.width+gap,top=rect.y-original.height-gap,bottom=rect.y+rect.height+gap;
  for(const [x,y] of [[left,preferred.y],[right,preferred.y],[preferred.x,top],[preferred.x,bottom],[left,top],[right,top],[left,bottom],[right,bottom]])add(x,y);
 }
 return [...candidates.values()].sort((a,b)=>(a.x-original.x)**2+(a.y-original.y)**2-((b.x-original.x)**2+(b.y-original.y)**2)||a.y-b.y||a.x-b.x);
}

/** Ordered, display-only placement. Earlier fixed targets never move when a
 * later temporary hover is added. All candidates come from real box edges. */
export function placeResultLabels(inputs:readonly ResultLabelLayoutInput[],bounds:{width:number;height:number},gap=6){
 const placed=new Map<string,ResultLabelPlacement>(),margin=4;
 if(![bounds.width,bounds.height,gap].every(Number.isFinite)||bounds.width<=0||bounds.height<=0||gap<0)return placed;
 for(const item of inputs){
  if(placed.has(item.id)||![item.point.x,item.point.y,item.width,item.height].every(Number.isFinite)||item.width<=0||item.height<=0||item.target&&![item.target.x,item.target.y].every(Number.isFinite))continue;
  const original={x:item.point.x-(item.anchor==='center'?item.width/2:0),y:item.point.y-(item.anchor==='center'?item.height/2:0),width:item.width,height:item.height};
  const existing=[...placed.values()].map(value=>value.rect),candidates=resultLabelCandidates(original,existing,bounds,gap);
  const available=candidates.find(candidate=>!existing.some(other=>resultLabelRectsOverlap(candidate,other,gap))),rect=available??candidates[0];
  const moved=Math.hypot(rect.x-original.x,rect.y-original.y)>1;
  const target=item.target??item.point,to={x:Math.max(rect.x,Math.min(rect.x+rect.width,target.x)),y:Math.max(rect.y,Math.min(rect.y+rect.height,target.y))};
  placed.set(item.id,{rect,...(!available||rect.width>bounds.width-2*margin||rect.height>bounds.height-2*margin?{unresolved:true}:{}),...(moved&&Math.hypot(to.x-target.x,to.y-target.y)>1?{leader:{from:{...target},to}}:{})});
 }
 return placed;
}
