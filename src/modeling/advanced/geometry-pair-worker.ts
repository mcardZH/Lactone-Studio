import type { Structure } from '../../core/types';
import { createConformerGeometryComparer } from '../conformers/clustering';

let structures: Structure[] = [], threshold = .01;
const compare = createConformerGeometryComparer();
self.onmessage = (event: MessageEvent) => {
  const request=event.data;
  try {
    if(request.kind==='register') {
      structures=request.structures;threshold=request.threshold;
      self.postMessage({kind:'registered'});return;
    }
    if(request.kind!=='compare')throw new Error('未知几何工作块。');
    const moving=structures[request.movingIndex];let duplicate=false;
    for(const index of request.referenceIndices) {
      const reference=structures[index];
      if(moving.charge!==reference.charge||moving.multiplicity!==reference.multiplicity)continue;
      const fit=compare(moving,reference);
      if(fit.comparable&&fit.rmsdAngstrom<threshold){duplicate=true;break;}
    }
    self.postMessage({kind:'compared',id:request.id,duplicate});
  } catch(error){self.postMessage({kind:'error',error:error instanceof Error?error.message:String(error)});}
};
