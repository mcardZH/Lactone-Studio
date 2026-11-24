import type {ScientificGrid} from './export-saved-cube';
import type {AnalysisOriginalCubeSource} from '../../projects/analysis-state';

export interface AnalysisAssetInfo {
  id:string;
  filename:string;
  kind:'cube'|'text';
  mimeType:string;
  provenance?:unknown;
  coordinateUnit?:string;
  valueUnit?:string|null;
  validDomain?:string;
}

export type AnalysisAsset = {
  info:AnalysisAssetInfo;
} & ({kind:'cube';field:ScientificGrid;original?():Promise<AnalysisOriginalCubeSource|undefined>}
  | {kind:'text';text():string});

export function analysisCube(id:string,field:ScientificGrid,provenance:unknown,original?:()=>Promise<AnalysisOriginalCubeSource|undefined>):AnalysisAsset {
  return {kind:'cube',field,original,info:{id,filename:`Ester-Studio-${id}.cube`,kind:'cube',mimeType:'chemical/x-gaussian-cube',
    provenance,coordinateUnit:field.grid.coordinateUnit,valueUnit:field.valueUnit,validDomain:field.validDomain.kind}};
}

export function analysisText(id:string,text:()=>string,provenance:unknown,format:'txt'|'json'='txt'):AnalysisAsset {
  return {kind:'text',text,info:{id,filename:`Ester-Studio-${id}.${format}`,kind:'text',mimeType:format==='json'?'application/json':'text/plain',provenance}};
}
