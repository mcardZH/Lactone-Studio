import { preparePackedDisplayMeshWork } from './surface-mesh-preparation';
import type { SurfaceMeshTopology } from './surface-mesh';
import { CubeReadError, parseDisplayCube, type DisplayCubeRead } from '../../../results/cube-reader';
import { meshRequest, packedMeshTransfer, type MeshBuildPacket, type MeshSource } from './surface-mesh-transfer';
import { finishRenderWork } from './render-work';

const post = (value: unknown, transfer: Transferable[]) =>
  (self as unknown as { postMessage(data: unknown, transfer: Transferable[]): void }).postMessage(value, transfer);
let source: MeshSource | undefined;
let topology: SurfaceMeshTopology | undefined;

self.addEventListener('message', (event: MessageEvent<MeshBuildPacket | DisplayCubeRead>) => {
  const request = event.data;
  try {
    if ('text' in request) {
      const cube = parseDisplayCube(request), transfer: Transferable[] = [cube.parsed.values.buffer];
      if (cube.originalBytes) transfer.push(cube.originalBytes.buffer);
      post({ cube }, transfer);
    } else {
      if (request.source) source = request.source;
      if (request.topology) topology = request.topology;
      if (!source || !topology) throw new Error('表面网格来源未登记。');
      const chunks=finishRenderWork(preparePackedDisplayMeshWork(meshRequest(request.parameters,source),topology));
      post({ id: request.id, chunks }, packedMeshTransfer(chunks));
    }
  } catch (error) {
    self.postMessage({ ...('id' in request ? { id: request.id } : {}),
      error: error instanceof Error ? error.message : String(error), ...(error instanceof CubeReadError ? { code: error.code } : {}) });
  }
});
