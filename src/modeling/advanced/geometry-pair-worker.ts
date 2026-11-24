import type { SharedModelConstraints } from '../../core/modeling/contracts';
import type { Structure } from '../../core/types';
import { createConformerGeometryComparer } from '../conformers/clustering';
import { geometryWorkerFrames } from './geometry-worker-frames';

let structures: Structure[] = [], threshold = .01;
let frames = geometryWorkerFrames();
const compare = createConformerGeometryComparer();
let constraints: SharedModelConstraints | undefined;
self.onmessage = (event: MessageEvent) => {
  const request=event.data;
  try {
    if(request.kind==='register') {
      frames=geometryWorkerFrames();structures=frames.structures;threshold=request.threshold;
      constraints = request.frozenAtomIds ? { frozenAtomIds: request.frozenAtomIds, coordinates: [] } : undefined;
      self.postMessage({kind:'registered'});return;
    }
    if(request.kind==='frames'){
      for(const frame of request.frames)frames.add(frame);
      self.postMessage({kind:'registered'});return;
    }
    if(request.kind!=='compare')throw new Error('未知几何工作块。');
    const moving=structures[request.movingIndex];let duplicate=false;
    for(const index of request.referenceIndices) {
      const reference=structures[index];
      if(moving.charge!==reference.charge||moving.multiplicity!==reference.multiplicity)continue;
      const fit=compare(moving, reference, constraints, constraints);
      if(fit.comparable&&fit.rmsdAngstrom<threshold){duplicate=true;break;}
    }
    self.postMessage({kind:'compared',id:request.id,duplicate});
  } catch(error){self.postMessage({kind:'error',error:error instanceof Error?error.message:String(error)});}
};
