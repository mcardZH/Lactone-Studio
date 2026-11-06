import type { Structure } from '../../core/types';
import type { CalculationRangeFeedback } from '../../results/calculation-range';
import type { ExcitationDensityField, ExcitationResult, ExcitationRunRequest, ExcitationSessionInfo, ExcitationStateRef, HoleElectronResult, NtoAnalysisResult, NtoField } from '../../results/excitation-contracts';
import type { SurfaceContext, SurfaceCubeQuality } from '../../results/surface-contracts';
import type { MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import type { OrbitalLayerSettings } from './orbital-display';
import type { MeshFinishSettings } from '../../results/mesh-appearance';
import type { LocalAppearanceId } from './SurfaceAppearanceControls';
export interface ExcitationControlsBridge {
 run?(request:Omit<ExcitationRunRequest,'stamp'> & {requestId:string;context:SurfaceContext},signal:AbortSignal):Promise<ExcitationResult>;
 cancel?(requestId:string):void|Promise<void>;
 exportCube?(field:NtoField|ExcitationDensityField,signal:AbortSignal):Promise<void>;
}
export interface ExcitationDensityDisplay { mode:'hole'|'electron'|'overlay';visible:boolean;isovalue:number;opacity:number;holeColor:string;electronColor:string;finish?:MeshFinishSettings;appearancePreset?:LocalAppearanceId }
export interface ExcitationProjection extends CalculationRangeFeedback {
 context:SurfaceContext;state:ExcitationStateRef;displayOwner:'nto'|'electron-hole'|null;
 nto:NtoAnalysisResult|null;ntoField:NtoField|null;ntoFieldRequestId:string|null;ntoDisplay:OrbitalLayerSettings;
 holeElectron:HoleElectronResult|null;densityFields:readonly ExcitationDensityField[];densityDisplay:ExcitationDensityDisplay;decimals:number;
}
export interface ExcitationAnalysisControlsProps {
 structure?:Structure;context:SurfaceContext;state:ExcitationStateRef|null;active:boolean;available?:boolean;wavefunctionAvailable:boolean;
 unavailableReason?:string;
 /** NTO and density targets may be changed independently after a table click. */
 electronHoleState?:ExcitationStateRef|null;
 states?:readonly ExcitationStateRef[];onStateChange?(state:ExcitationStateRef,owner?:'nto'|'electron-hole'):void;
 info:ExcitationSessionInfo|null;bridge:ExcitationControlsBridge;progress?:MultiwfnProgressSnapshot|null;decimals?:number;
 onProjection(value:ExcitationProjection|null):void;onError?(message:string):void;onExportImage?():void|Promise<void>;
 onAccepted?(requestId:string,operation:ExcitationRunRequest['operation'],renderRequired:boolean):void;
}
export type ExcitationQuality='toy'|'low'|'medium'|'high'|'artistic'|'custom';
export const EXCITATION_QUALITY=[{value:'toy',tier:'toy'},{value:'low',tier:'coarse'},{value:'medium',tier:'medium'},{value:'high',tier:'fine'},{value:'artistic',tier:'artistic'},{value:'custom',tier:'custom'}] as const;
/** Keep the three accepted native presets unchanged; explicit dimensions use the existing native route. */
export const excitationQuality=(mode:ExcitationQuality,spacingBohr=.2):SurfaceCubeQuality=>mode==='toy'?{mode:'dimensions',dimensions:[32,32,32]}:mode==='artistic'?{mode:'dimensions',dimensions:[160,160,160]}:mode==='custom'?{mode:'spacing',spacingBohr}:{mode};
export const excitationQualityDescription=(mode:ExcitationQuality,spacingBohr=.2)=>mode==='toy'?'网格 32 × 32 × 32':mode==='artistic'?'网格 160 × 160 × 160':mode==='custom'?`格距 ${spacingBohr} bohr`:`原生目标点数 ${{low:125000,medium:512000,high:1728000}[mode]}（实际网格见结果）`;
