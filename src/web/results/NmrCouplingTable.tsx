import { useMemo } from 'react';
import type { TrajectoryResult } from '../../results/contracts';
import { nmrCouplingTableProjection } from '../../results/nmr-coupling-projection';
import { ScientificDataTable } from './ScientificDataTable';
import type { ScientificTableLayoutState, ScientificTableProjection } from './scientific-table';

/** Printed pair observations only. Rendering and copying share the neutral
 * source projection; no per-atom coloring, unit conversion or spectrum state. */
export default function NmrCouplingTable({ result, currentIndex, hideTitle, selectionScope, layoutState, onLayoutChange, projection: suppliedProjection }: {
  result: TrajectoryResult; currentIndex?: number; hideTitle?: boolean; selectionScope?: string;
  layoutState?: ScientificTableLayoutState; onLayoutChange?(value: ScientificTableLayoutState): void;
  /** Reuse the parent's complete projection for presence, display and export. */
  projection?: ScientificTableProjection;
}) {
  const projection = useMemo(() => suppliedProjection ?? (result.scientific ? nmrCouplingTableProjection(result.scientific, result.source, currentIndex) : undefined), [suppliedProjection, result.scientific, result.source, currentIndex]);
  if (!projection?.rows.length) return null;
  return <ScientificDataTable title="核自旋耦合" hideTitle={hideTitle} projection={projection}
    selectionScope={selectionScope ?? `${result.source.id}:${result.id}:${result.jobIndex}:nmr-couplings:${currentIndex ?? 'all'}`}
    exportFileName={`Ester-Studio-nmr-couplings-job-${result.jobIndex + 1}.txt`} layoutState={layoutState} onLayoutChange={onLayoutChange}
    format={{ decimals: 2, onDecimalsChange() {}, locked: true, ariaLabel: '核自旋耦合' }}/>;
}
