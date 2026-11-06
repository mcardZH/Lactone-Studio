import { useState } from 'react';
import type { ScfCycle } from '../../results/scientific-contracts';
import { scientificDisplayValue as number } from './scientific-presentation';
import { PagedScientificRows } from './PagedScientificRows';
import ScientificPlot from './ScientificPlot';

export default function ScientificScfCycle({ cycle, ordinal }: { cycle: ScfCycle; ordinal: number }) {
  const [open, setOpen] = useState(false);
  return <details className="scientific-scf" onToggle={event => setOpen(event.currentTarget.open)}><summary>周期 {ordinal + 1} · {cycle.points.length} 次记录</summary>{open && <><ScientificPlot title={`当前帧 SCF 周期 ${ordinal + 1}`} xLabel="SCF 迭代（当前周期）" yLabel="E / hartree" ariaLabel={`当前帧 SCF 周期 ${ordinal + 1}，能量单位 hartree`} series={[{id:'scf-cycle',showPoints:true,points:cycle.points.map(point=>({x:point.iteration,y:point.energy}))}]} resetKey={`${cycle.sourceLine}:${ordinal}`} metadata={{sourceLine:cycle.sourceLine,frameIndex:cycle.frameIndex}}/><table className="scientific-table"><thead><tr><th>迭代</th><th>E / hartree</th><th>ΔE / hartree</th></tr></thead><PagedScientificRows rows={cycle.points} columns={3} renderRow={point => <tr key={point.iteration}><td>{point.iteration}</td><td>{number(point.energy)}</td><td>{number(point.deltaEnergy)}</td></tr>}/></table><p className="scientific-note">长周期按极值缩略显示，含缺项区间保守断线；表格按页查看。</p></>}</details>;
}
