import type { PostprocessDocument } from '../../results/postprocess-document';
import { resultFile } from '../../results/input-file';
import type { SnapshotProjectSources } from './snapshot-project';
import { retainPostprocessSourceExtras, type PostprocessSourceExtra } from '../../projects/postprocess-extra-sources';
/** Imported Cube originals remain source assets even before a cache restores
 * the analysis that first used them. Keep their own snapshot consumer lease. */
export function retainSnapshotPostprocessSources(document:PostprocessDocument,bundle:SnapshotProjectSources):void {
 const sources:PostprocessSourceExtra[]=[];
 for(const metadata of bundle.description.files.filter(file=>file.format==='cube')){
  const file=bundle.files.find(file=>file.snapshotIdentity.sourceRef===metadata.sourceRef);if(!file)throw Error('任务原始Cube来源不可取得。');
  const input=resultFile(file);sources.push({name:metadata.name,sourceId:metadata.sha256,revision:metadata.sha256,byteSize:metadata.byteSize,format:'cube',readRange:(start,end,signal)=>input.readRange(start,end,signal)});
  const dispose=document.result.dispose.bind(document.result);document.result.dispose=async()=>{await input.close?.();return dispose();};
 }
 if(sources.length)retainPostprocessSourceExtras(document,sources);
}
