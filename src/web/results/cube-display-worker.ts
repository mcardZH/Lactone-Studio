import { CubeReadError, readMolecularCube, type CubeReadOptions } from '../../results/cube-reader';

const port = self as unknown as {
  onmessage: ((event: MessageEvent<{ size: number; stream: ReadableStream<Uint8Array>; options: CubeReadOptions }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

port.onmessage = ({ data }) => {
  port.onmessage = null;
  void readMolecularCube({ size: data.size, stream: () => data.stream }, data.options).then(
    parsed => port.postMessage({ parsed }, parsed.values.buffer instanceof ArrayBuffer ? [parsed.values.buffer] : []),
    error => port.postMessage({ error: error instanceof Error ? error.message : String(error),
      ...(error instanceof CubeReadError ? { code: error.code } : {}) }),
  );
};
