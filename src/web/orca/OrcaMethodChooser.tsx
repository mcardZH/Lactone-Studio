import { authorBasisEvaluation, authorMethodEvaluation } from '../../core/author-evaluations';
import { getOrcaMethodProfile, getOrcaMethods, ORCA_BASES } from '../../core/orca/catalog';
import { getOrcaCommonMethodProfile, getOrcaCommonMethods, getOrcaMethodMinimumVersion } from '../../core/orca/common';
import type { OrcaMethodId, OrcaSettings } from '../../core/orca/types';
import type { Structure } from '../../core/types';
import { basisSize } from '../../core/basis';
import CardDropdown, { type CardOption } from '../CardDropdown';

export interface OrcaMethodChooserProps {
  settings: OrcaSettings;
  onMethod: (id: OrcaMethodId) => void;
  onBasis: (basis: string) => void;
  common?: boolean;
  structure?: Structure | null;
}

/** Shared card presentation; ORCA's catalog remains the method/version/task authority. */
export default function OrcaMethodChooser({ settings, onMethod, onBasis, common = false, structure = null }: OrcaMethodChooserProps) {
  const method = common ? getOrcaCommonMethodProfile(settings.method) : getOrcaMethodProfile(settings.method, settings.version);
  const methods: CardOption[] = (common ? getOrcaCommonMethods(settings.task) : getOrcaMethods(settings.version, settings.task)).map(profile => {
    const evaluation = authorMethodEvaluation('orca', profile.id);
    return { value: profile.id, label: profile.label + (common && getOrcaMethodMinimumVersion(profile.id) !== '5' ? ' · 最低 ORCA 6.0' : ''), body: <>
      {evaluation && <p data-author-evaluation="method">{evaluation}</p>}
      {profile.basisPolicy === 'builtin' && <p className="orca-note">3c 使用方法内置基组与修正。</p>}
      {profile.basisPolicy === 'none' && <p className="orca-note">GFN2-xTB 不使用轨道基组。</p>}
    </> };
  });
  if (!methods.some(option => option.value === settings.method)) methods.unshift({
    value: settings.method, label: (method?.label ?? settings.method) + ' · 当前版本/任务需另选方法', disabled: true,
    body: <p className="orca-note">当前版本/任务需另选方法。</p>,
  });
  const bases: CardOption[] = ORCA_BASES.map(basis => {
    const evaluation = authorBasisEvaluation('orca', basis);
    // ORCA uses spherical orbital shells; retain missing catalog data as unknown.
    const size = structure?.atoms.length ? basisSize(structure, basis, '5D', '7F') : null;
    const count = !size ? '无显式坐标：不统计' : size.count === null ? '基函数数待核实' : size.count + ' 个基函数';
    return { value: basis, label: basis, summary: <span className="basis-stat" title={size?.reason} data-testid={basis===settings.basis?'orca-basis-count':undefined}>{count}</span>, body: evaluation ? <p data-author-evaluation="basis">{evaluation}</p> : null };
  });
  if (!bases.some(option => option.value === settings.basis)) bases.unshift({
    value: settings.basis, label: settings.basis || '请选择', body: null,
  });
  return <div className="method-chooser orca-method-chooser shared-input-card"><div className="shared-method-fields">
    <CardDropdown label="ORCA方法" displayLabel="计算方法" triggerLabel={method?.label??settings.method} layout="catalog" value={settings.method} options={methods}
      onChange={value => onMethod(value as OrcaMethodId)}
      footer={<p className="orca-note">{common ? '常见任务采用共同写法；较新专用方法保留并标注最低要求。' : `ORCA ${settings.version === '5' ? '5.x' : settings.version} · 按当前版本与任务列出方法。`}</p>} />
    {method?.basisPolicy === 'uniform-def2' ? <CardDropdown label="ORCA基组" displayLabel="基组" layout="catalog"
      value={settings.basis} options={bases} onChange={onBasis} /> :
      <p className="orca-note">{method?.basisPolicy === 'builtin' ? '3c 使用方法内置基组与修正。' : method?.basisPolicy === 'none' ? 'GFN2-xTB 不使用轨道基组。' : '请先选择当前版本与任务可用的方法。'}</p>}
  </div></div>;
}
