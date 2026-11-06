import type { ChemistryJob, ChemistryPort, ChemistryRequest, ChemistryResult } from '../contracts';

/** Browser preview adapter. Unsupported native operations fail, never approximate. */
export class WasmChemistryPort implements ChemistryPort {
  async capabilities() {
    return { engine: 'OpenBabel WASM', native: false,
      operations: ['generate3d', 'optimize'] as ChemistryRequest['operation'][] };
  }

  start(submitted: ChemistryRequest): ChemistryJob {
    const request = structuredClone(submitted);
    let cancelled = false;
    let inner: { cancel(): void } | null = null;
    let rejectOuter: (error: Error) => void = () => {};
    const promise = new Promise<ChemistryResult>((resolve, reject) => {
      rejectOuter = reject;
      void (async (): Promise<ChemistryResult> => {
        if (!['generate3d', 'optimize'].includes(request.operation))
          throw new Error('此操作需要桌面版原生化学引擎。');
        if (request.structure.cell?.pbc.some(Boolean))
          throw new Error('周期模型不执行分子力场整理或全体系三维重建。');
        if (request.constraints?.some(row => row.action === 'freeze'))
          throw new Error('内坐标冻结整理需要桌面原生约束引擎；原模型未改变。');
        const ids = request.structure.atoms.map(atom => atom.id);
        const movable = new Set(request.movableAtomIds);
        if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length ||
            !movable.size || [...movable].some(id => !ids.includes(id)))
          throw new Error('没有有效可动原子，或原子身份不完整。');
        if (request.operation === 'generate3d' && movable.size !== ids.length)
          throw new Error('生成三维不能重建部分冻结的模型。');
        if (!request.structure.bonds) throw new Error('缺少明确连接表；请先主动识别成键。');
        const module = await import('../../web/chemistry');
        if (cancelled) throw new Error('已取消，原模型未改变。');
        const operation = request.operation === 'optimize' ? 'optimize-local' : 'generate3d';
        const job = module.startChemistry(operation, module.chemistryInput(request.structure),
          request.forcefield ?? 'auto', undefined, request.steps ?? 300,
          { movableAtomIds: request.movableAtomIds });
        inner = job;
        const result = await job.promise;
        if (cancelled) throw new Error('已取消，原模型未改变。');
        if (request.structure.charge !== null && result.charge !== request.structure.charge)
          throw new Error('化学引擎改变了体系电荷；结果未应用。');
        const structure = module.chemistryStructure(result, request.structure, request.structure.name);
        structure.charge = request.structure.charge;
        structure.multiplicity = request.structure.multiplicity;
        return { stamp: request.stamp, operation: request.operation, structure,
          movableAtomIds: request.movableAtomIds, engine: 'OpenBabel WASM',
          engineVersion: 'Kekule 1.0.4 bundled runtime', forcefield: result.forcefield,
          before: result.before, after: result.after, unit: result.unit,
          converged: result.converged,
          warnings: result.limitReached ? ['达到整理上限，未声明收敛。'] : [] };
      })().then(resolve, reject);
    });
    return { promise, cancel() {
      if (cancelled) return;
      cancelled = true; inner?.cancel(); rejectOuter(new Error('已取消，原模型未改变。'));
    } };
  }
}
