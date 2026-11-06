import type {SnapshotProjectSources,SnapshotScientificSourceFile} from './snapshot-project';

/** Raw restart/auxiliary bytes remain in the fixed snapshot. Only supported
 * result slots enter the existing source readers; paths/extensions confer no role. */
export function snapshotPostprocessSources(bundle:SnapshotProjectSources):SnapshotScientificSourceFile[]{
  const directWavefunctions=new Set(['gaussian-formatted-checkpoint','fchk','molden']);
  const selected=bundle.files.filter(file=>{
    const metadata=bundle.description.files.find(row=>row.sourceRef===file.snapshotIdentity.sourceRef);
    if(!metadata)throw Error('快照来源未列入固定清单。');
    if(metadata.representation==='binary')return false;
    if(metadata.roles.some(role=>['primary-output','trajectory','modes'].includes(role)))return true;
    return metadata.roles.includes('wavefunction')&&directWavefunctions.has(metadata.format??'');
  });
  if(!selected.length)throw Error('当前快照尚无可直接读取的OUT、轨迹、HESS、FCHK或Molden来源。');
  return selected;
}
