import type { Structure } from '../core/types';
import { molecularFormula } from '../core/elements';
import { molecularMass } from '../core/molecular-mass';

export default function StructureSummary({ structure, reference = false }: { structure: Structure; reference?: boolean }) {
  const mass = molecularMass(structure.atoms), formula = molecularFormula(structure.atoms);
  return <section className="structure-summary-nine" aria-label={reference ? '参考结构信息' : '分子结构信息'}>
    <div className="structure-source-name" title={structure.name}>{structure.name}{structure.dimension === 2 && <span> · 2D待生成三维</span>}</div>
    <div className="structure-facts-nine">
      <div className="structure-formula-nine"><span>{reference ? '参考化学式' : '化学式'}</span><strong aria-label={'化学式 ' + formula}>{formula.split(/(\d+)/).map((part, index) => /^\d+$/.test(part) ? <sub key={index}>{part}</sub> : part)}</strong></div>
      <div><span>{reference ? '参考原子数' : '原子数'}</span><strong data-testid="structure-atom-count">{structure.atoms.length}</strong></div>
      <div><span>{reference ? '参考分子量' : '分子量'}</span><strong data-testid="structure-molecular-mass" title={mass.unknownElements.length?'无标准原子量：'+mass.unknownElements.join('、'):undefined}>{mass.value === null ? '未知' : mass.value.toFixed(3)}{mass.value !== null && <small> g/mol</small>}</strong></div>
    </div>
    {reference && <p className="structure-reference-note">仅为导入的参考结构；不代表二进制CHK内实际几何。</p>}
  </section>;
}
