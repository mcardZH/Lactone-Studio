import type { Structure } from '../core/types';
import BuilderWorkspace from './BuilderWorkspace';
import DialogShell from './DialogShell';

/** Legacy entry point; all editing is owned by the same shared builder implementation. */
export default function MoleculeEditor({structure,onApply,onClose}:{structure:Structure|null;onApply:(structure:Structure)=>void;onClose:()=>void}){
  return <DialogShell className="builder-modal" backdropClassName="builder-modal-backdrop" aria-label="绘制与编辑分子" onCancel={onClose}><button className="builder-modal-close" aria-label="关闭分子编辑器" onClick={onClose}>✕</button><BuilderWorkspace structure={structure} onApply={result=>onApply(result.structure)} onCancel={onClose}/></DialogShell>;
}
