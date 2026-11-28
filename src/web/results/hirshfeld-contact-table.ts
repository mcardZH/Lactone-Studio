import {hirshfeldContactKey} from '../../results/hirshfeld-presentation';
import {formatAnalysisValue} from './analysis-display';
import type {HirshfeldControlsState} from './hirshfeld-controls-contracts';
import type {ScientificTableProjection} from './scientific-table';

export function hirshfeldContactTable(state:HirshfeldControlsState) {
  const {merged,decimals,contactNumberFormat,areaSort,areaSortDirection}=state;
  const contacts=state.result?.contacts;
  const rows=[...(merged?contacts?.mergedRows??[]:contacts?.directedRows??[])].sort((a,b)=>{
    const value=areaSort==='contact'
      ?`${a.insideElement}:${a.outsideElement}`.localeCompare(`${b.insideElement}:${b.outsideElement}`)
      :areaSort==='area'?a.area-b.area:a.nativePercent-b.nativePercent;
    return areaSortDirection==='asc'?value:-value;
  });
  const table:ScientificTableProjection={
    columns:[
      {key:'contact',label:merged?'接触（双向合并）':'接触（内→外）'},
      {key:'area',label:'接触面积 / Å²',heading:'接触面积',headerUnit:'Å²'},
      {key:'percent',label:'完整表面占比 / %',heading:'完整表面占比',headerUnit:'%'},
    ],
    rows:rows.map(row=>({key:hirshfeldContactKey(row.insideElement,row.outsideElement,merged),cells:[
      `${row.insideElement}${merged?'···':' → '}${row.outsideElement}`,
      formatAnalysisValue(row.area,decimals,contactNumberFormat),
      formatAnalysisValue(row.nativePercent,decimals,contactNumberFormat),
    ]})),
  };
  return {rows,table};
}
