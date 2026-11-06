import type {DisplaySettings} from '../../modeling/contracts';
import type {PhysicalAxisProjection} from './render/camera';
import {axisOverlayMetrics} from './render/display-settings';

/** Screen axes retain the same projected directions and default geometry. */
export default function PhysicalAxesOverlay({axes,display}:{axes:readonly PhysicalAxisProjection[];display:DisplaySettings}){
  const {settings,size,center}=axisOverlayMetrics(display);
  return <svg className="model-physical-axes" data-testid="model-physical-axes" viewBox={`0 0 ${size} ${size}`} style={{width:size,height:size}} aria-label="物理XYZ坐标轴">
    {[...axes].sort((a,b)=>a.depth-b.depth).map(axis=><g key={axis.axis} data-axis={axis.axis} data-depth={axis.depth} stroke={settings.colors[axis.axis]}>
      <line x1={center} y1={center} x2={center+axis.x*settings.length} y2={center+axis.y*settings.length} style={{strokeWidth:settings.lineWidth}}/>
      <circle cx={center+axis.x*settings.length} cy={center+axis.y*settings.length} r="2"/>
      <text x={center+axis.x*(settings.length+7)} y={center+4+axis.y*(settings.length+7)} fill={settings.colors[axis.axis]} stroke="none" style={{font:`600 ${settings.fontSize}px system-ui`}}>{axis.axis}</text>
    </g>)}
  </svg>;
}
