import type { EnergyUnit } from '../../results/energy';

export const energyPlotUnits: readonly EnergyUnit[] = ['hartree', 'eV', 'kJ/mol', 'kcal/mol'];
export const plotEnergyUnit = (unit: EnergyUnit) => unit === 'hartree' ? 'Eₕ' : unit;

export function EnergyPlotUnit({ unit, onChange, label = '能量单位' }: {
  unit: EnergyUnit; onChange(unit: EnergyUnit): void; label?: string;
}) {
  return <label>单位 <select aria-label={label} value={unit} onChange={event => onChange(event.target.value as EnergyUnit)}>
    {energyPlotUnits.map(value => <option key={value} value={value}>{plotEnergyUnit(value)}</option>)}
  </select></label>;
}

export function EnergyPlotZero({ value, choices, onChange, selecting, canSelect, pointLabel }: {
  value: string; choices: readonly { value: string; label: string; disabled?: boolean }[];
  onChange(value: string): void; selecting: boolean; canSelect: boolean; pointLabel?: string;
}) {
  return <label>零点 <select aria-label="能量参考" value={selecting ? 'pick' : value} onChange={event => onChange(event.target.value)}>
    <option value="original">原始值</option>
    {choices.map(choice => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>)}
    {pointLabel && <option value="point" hidden>{pointLabel}</option>}
    <option value="pick" disabled={!canSelect}>{selecting ? '点选曲线上的数据点' : '从曲线上选点…'}</option>
    {selecting && <option value="cancel">取消选点</option>}
  </select></label>;
}
