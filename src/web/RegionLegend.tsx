import { regionMembership, type MoleculeRegion } from '../core/regions';
export default function RegionLegend({regions,atomCount,selectionHint=true}:{regions:MoleculeRegion[];atomCount:number;selectionHint?:boolean}){
  if(!regions.length)return null;const {unassigned,overlapping}=regionMembership(atomCount,regions);
  return <div className="region-legend" aria-label="结构区域图例" data-testid="region-legend">{regions.map(region=><span key={region.id} data-region-id={region.id}><i style={{backgroundColor:region.color}}/>{region.label} · {new Set(region.atomIndices).size}原子{region.style==='stick'?' · 棒状':region.style==='ball'?' · 球棍':''}</span>)}{!!unassigned.length&&<span><i style={{backgroundColor:'#b8c1c9'}}/>未分配 · {unassigned.length}原子</span>}{!!overlapping.length&&<span className="region-warning"><i style={{backgroundColor:'#d96d78'}}/>归属重叠 · {overlapping.length}原子</span>}{selectionHint&&<small>当前选择加粗显示；图例仅对应当前可见着色层</small>}</div>;
}
