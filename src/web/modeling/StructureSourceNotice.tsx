import type {Structure} from '../../core/types';
import {PostprocessSourceFeedback} from '../results/PostprocessSourceFeedback';

/** Show coordinate-source decisions beside the model, including in reopened
 * projects where the importer's notes are the available provenance. */
export function StructureSourceNotice({structure}:{structure:Structure}){
  const notices=structure.notes.filter(note=>note.includes('CIF坐标来源说明：') ||
    /^PDB (?:CRYST1不完整|SCALE(?:变换|矩阵))|^PDB来源 .*CRYST1为非晶体单位占位值/.test(note));
  const cellSource=structure.cell?.pbcProvenance?.evidence;
  if(cellSource?.startsWith('PDB晶胞方向及原点按SCALE变换恢复'))notices.push(cellSource);
  if(notices.length===0)return null;
  const message=[...new Set(notices)].join(' ');
  return <PostprocessSourceFeedback key={message} label="结构坐标来源" message={message}/>;
}
