import type { Structure, Vector3 } from '../core/types';
import { BOHR_TO_ANGSTROM } from '../core/orca/assets';
import type { SurfaceCubeQuality, SurfaceGrid } from './surface-contracts';

export type CalculationRangeGrid = Pick<SurfaceGrid, 'origin' | 'axes' | 'dimensions' | 'coordinateUnit'>;
/** A bounded display plan. It contains no scalar field, atom selection or run owner. */
export interface CalculationRangeDisplay {
  key: string;
  label: string;
  estimated: boolean;
  grid: CalculationRangeGrid;
}
export const CALCULATION_RANGE_STYLE = Object.freeze({ color: '#7797b0', linewidth: 1.3, opacity: .55 });
const finiteVector = (value: unknown): value is Vector3 => Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n));
export function validateCalculationRange(value: CalculationRangeDisplay): void {
  const grid = value?.grid;
  if (!value || typeof value.key !== 'string' || !value.key || value.key.length > 512 || typeof value.label !== 'string' || value.label.length > 100 || typeof value.estimated !== 'boolean'
    || !grid || !['bohr', 'angstrom'].includes(grid.coordinateUnit) || !finiteVector(grid.origin) || !Array.isArray(grid.axes) || grid.axes.length !== 3 || !grid.axes.every(finiteVector)
    || !Array.isArray(grid.dimensions) || grid.dimensions.length !== 3 || !grid.dimensions.every(n => Number.isSafeInteger(n) && n >= 2 && n <= 16777216)) throw new Error('计算范围缺少有限原点、三轴、网格点数或单位。');
  if(grid.axes.some((axis,i)=>axis.some(n=>!Number.isFinite(n*(grid.dimensions[i]-1))))||[0,1,2].some(j=>!Number.isFinite(grid.origin[j]+grid.axes.reduce((sum,axis,i)=>sum+Math.abs(axis[j])*(grid.dimensions[i]-1),0))))throw new Error('计算范围边界超出有限坐标。');
  const [a,b,c] = grid.axes;
  const determinant=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-20) throw new Error('计算范围三轴退化。');
}
export function calculationRangeFromGrid(grid: CalculationRangeGrid, key: string, label: string, estimated = false): CalculationRangeDisplay {
  const value: CalculationRangeDisplay={key,label,estimated,grid:{coordinateUnit:grid.coordinateUnit,origin:[...grid.origin],axes:grid.axes.map(axis=>[...axis]) as [Vector3,Vector3,Vector3],dimensions:[...grid.dimensions]}};
  validateCalculationRange(value);return value;
}
/** Geometric estimate only: native field generation still receives its original quality. */
export function estimatedCalculationRange(structure: Structure, quality: SurfaceCubeQuality, extensionBohr: number, key: string, label: string, reference?: CalculationRangeGrid | null): CalculationRangeDisplay | null {
  const atoms=structure.atoms;if(!atoms.length||atoms.some(atom=>![atom.x,atom.y,atom.z].every(Number.isFinite))||!Number.isFinite(extensionBohr)||extensionBohr<0)return null;
  if(reference){try{validateCalculationRange({key,label,estimated:true,grid:reference});}catch{return null;}}
  const factor=reference?.coordinateUnit==='angstrom'?BOHR_TO_ANGSTROM:1;
  const extents=reference?reference.axes.map((axis,i)=>Math.hypot(...axis)*(reference.dimensions[i]-1)/factor)
    :(['x','y','z'] as const).map(axis=>(Math.max(...atoms.map(atom=>atom[axis]))-Math.min(...atoms.map(atom=>atom[axis])))/BOHR_TO_ANGSTROM+2*extensionBohr);
  if(extents.some(value=>!Number.isFinite(value)||value<=0))return null;
  const spacing=quality.mode==='dimensions'?null:quality.mode==='spacing'?quality.spacingBohr:Math.cbrt(extents.reduce((a,b)=>a*b,1)/(quality.mode==='target-points'?quality.targetPoints:{low:125000,medium:512000,high:1728000}[quality.mode]));
  if(spacing!==null&&(!Number.isFinite(spacing)||spacing<=0))return null;
  const dimensions=quality.mode==='dimensions'?[...quality.dimensions]:extents.map(length=>Math.max(2,Math.ceil(length/spacing!)+1));
  if(dimensions.some(value=>!Number.isSafeInteger(value)||value<2||value>16777216))return null;
  const origin:Vector3=reference?[...reference.origin]:['x','y','z'].map(axis=>Math.min(...atoms.map(atom=>atom[axis as 'x'|'y'|'z']))/BOHR_TO_ANGSTROM-extensionBohr) as Vector3;
  const axes:[Vector3,Vector3,Vector3]=reference?reference.axes.map((axis,i)=>axis.map(n=>n*(reference.dimensions[i]-1)/(dimensions[i]-1))) as [Vector3,Vector3,Vector3]
    :extents.map((extent,i)=>[0,1,2].map(j=>i===j?extent/(dimensions[i]-1):0)) as [Vector3,Vector3,Vector3];
  return calculationRangeFromGrid({origin,axes,dimensions:dimensions as [number,number,number],coordinateUnit:reference?.coordinateUnit??'bohr'},key,label,true);
}
/** Sparse wire grid on the six faces, in scientific Angstrom coordinates. */
export function calculationRangeLines(value: CalculationRangeDisplay): readonly (readonly [Vector3,Vector3])[] {
  validateCalculationRange(value);const {grid}=value,factor=grid.coordinateUnit==='bohr'?BOHR_TO_ANGSTROM:1;
  const point=(fractions:readonly number[]):Vector3=>[0,1,2].map(j=>(grid.origin[j]+grid.axes.reduce((sum,axis,i)=>sum+axis[j]*(grid.dimensions[i]-1)*fractions[i],0))*factor) as Vector3;
  const lines:[Vector3,Vector3][]=[],seen=new Set<string>();
  const add=(a:number[],b:number[])=>{const first=point(a),second=point(b),key=JSON.stringify([first,second].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));if(!seen.has(key)){seen.add(key);lines.push([first,second]);}};
  for(let fixed=0;fixed<3;fixed++)for(const side of [0,1])for(const along of [0,1,2].filter(axis=>axis!==fixed)){
    const cross=3-fixed-along,divisions=Math.min(6,grid.dimensions[cross]-1);
    for(let step=0;step<=divisions;step++){const a=[0,0,0],b=[0,0,0];a[fixed]=b[fixed]=side;a[cross]=b[cross]=step/divisions;b[along]=1;add(a,b);}
  }
  return lines;
}
export function uniqueCalculationRanges(values: readonly CalculationRangeDisplay[]): CalculationRangeDisplay[] {
  const result:CalculationRangeDisplay[]=[],seen=new Set<string>();
  for(const value of values){validateCalculationRange(value);const key=JSON.stringify(value.grid);if(!seen.has(key)){seen.add(key);result.push(value);}}
  return result;
}

/** Source-to-display fit operates in Angstrom, independently of grid storage units. */
export function transformCalculationRange(range: CalculationRangeDisplay, transform?: {rotation: readonly (readonly number[])[];translation:readonly number[]} | null): CalculationRangeDisplay {
  if(!transform)return range;
  validateCalculationRange(range);
  const factor=range.grid.coordinateUnit==='bohr'?BOHR_TO_ANGSTROM:1;
  const rotate=(point:readonly number[]):Vector3=>transform.rotation.map(row=>row.reduce((sum,value,i)=>sum+value*point[i],0)) as Vector3;
  const origin=rotate(range.grid.origin.map(value=>value*factor)).map((value,i)=>(value+transform.translation[i])/factor) as Vector3;
  return calculationRangeFromGrid({...range.grid,origin,axes:range.grid.axes.map(rotate) as [Vector3,Vector3,Vector3]},range.key,range.label,range.estimated);
}
export interface CalculationRangeFeedback { calculationRanges?: readonly CalculationRangeDisplay[] }
