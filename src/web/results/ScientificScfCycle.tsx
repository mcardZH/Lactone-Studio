import { useState } from 'react';
import type { ScfCycle } from '../../results/scientific-contracts';
import type { TrajectoryResult } from '../../results/contracts';
import { decimalEnergyValue as number } from '../../results/numeric-format';
import { PagedScientificRows } from './PagedScientificRows';
import PostprocessPlot from './PostprocessPlot';

export default function ScientificScfCycle({ cycle, ordinal, plotIdentity, result, frameIndex }: {
  cycle: ScfCycle; ordinal: number; plotIdentity: string; result: Pick<TrajectoryResult,'id'|'jobIndex'|'source'>; frameIndex: number;
}) {
  const [open, setOpen] = useState(false);
  return <details className="scientific-scf" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>周期 {ordinal + 1} · {cycle.points.length} 次记录</summary>
    {open && <>
      <PostprocessPlot compact snapshot={{ id:plotIdentity,kind:'scf',title:`SCF 周期 ${ordinal + 1}`,source:result.source,
        resultId:result.id,jobIndex:result.jobIndex,frameIndex,scfCycles:[cycle],orbitals:[] }}/>
      <table className="scientific-table"><thead><tr><th>迭代</th><th>E / hartree</th><th>ΔE / hartree</th></tr></thead>
        <PagedScientificRows rows={cycle.points} columns={3} renderRow={point => <tr key={point.iteration}><td>{point.iteration}</td><td>{number(point.energy)}</td><td>{number(point.deltaEnergy)}</td></tr>}/>
      </table>
      <p className="scientific-note">长周期按极值缩略显示，含缺项区间保守断线；表格按页查看。</p>
    </>}
  </details>;
}
