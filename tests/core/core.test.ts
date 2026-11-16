import { describe, it, expect } from 'vitest';
import type { MDPreparationProvenance } from '../../src/core/types';
import { createModelStore } from '../../src/core/modeling';
import { DynamicsController, createStoreDynamicsDependencies } from '../../src/modeling/dynamics/controller';
import type { DynamicsEvent, DynamicsRequest } from '../../src/modeling/dynamics/contracts';
import type { DynamicsPort } from '../../src/modeling/dynamics/port';
import { nativeMDRequiresFormat8 } from '../../src/projects/result-snapshot';

describe('Core MDPreparationProvenance & Dynamics Controller contracts', () => {
  it('persists nativeMD seedTreatment provenance across 6.8.0 verified and non-6.8.0 fallback paths', async () => {
    const store = createModelStore({
      id: 'h2-md-test',
      name: 'h2',
      format: 'xyz',
      dimension: 3,
      charge: 0,
      multiplicity: 1,
      notes: [],
      atoms: [
        { id: 'h1', element: 'H', x: 0, y: 0, z: 0, formalCharge: 0 },
        { id: 'h2', element: 'H', x: 0.74, y: 0, z: 0, formalCharge: 0 }
      ],
      bonds: [{ a: 0, b: 1, order: 1 }]
    });

    let listener: ((event: DynamicsEvent) => void) | undefined;
    let lastStart: { request: DynamicsRequest; sessionId: string } | undefined;
    const port: DynamicsPort = {
      async capabilities() {
        return { available: true };
      },
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      async start(request, sessionId) {
        lastStart = { request, sessionId };
      },
      async command() {}
    };

    const controller = new DynamicsController(port, createStoreDynamicsDependencies(store));
    const emit = (ev: DynamicsEvent) => listener?.(ev);
    const makeNativeEvent = (
      request: DynamicsRequest,
      sessionId: string,
      seq: number,
      event: 'frame' | 'stopped',
      engineVersion: string,
      seedTreatment: 'verified' | 'native-internal-initialization',
      structure?: DynamicsRequest['structure'],
      effectiveSeed?: number
    ): DynamicsEvent => ({
      schema: 1,
      sessionId,
      seq,
      event,
      stamp: request.stamp,
      operation: 'md',
      step: 10,
      timeFs: 20,
      engineVersion,
      ...(structure ? { structure } : {}),
      nativeMD: {
        method: 'gfn2',
        dtFs: 2,
        thermostat: 'Berendsen',
        hydrogenMassAmu: null,
        shakeHydrogenBonds: true,
        protection: 'none',
        protectedAtomIds: [],
        forceConstantKJMolNm2: 500000,
        segment: 0,
        velocityInitialization: 'fresh',
        nativeClosed: event === 'stopped',
        seedTreatment,
        ...(effectiveSeed === undefined ? {} : { effectiveSeed })
      }
    });

    // 1. Non-6.8.0 (e.g., Linux 6.7.1) native MD accepts 'native-internal-initialization' and writes MDPreparationProvenance
    await controller.start('md', { method: 'gfn2', temperatureK: 300, seed: 4242 });
    const req1 = lastStart!.request;
    const sid1 = lastStart!.sessionId;
    const nextStruct1 = structuredClone(req1.structure);
    nextStruct1.atoms[1].x = 0.75;
    emit(makeNativeEvent(req1, sid1, 1, 'frame', '6.7.1', 'native-internal-initialization', nextStruct1));
    emit(makeNativeEvent(req1, sid1, 2, 'stopped', '6.7.1', 'native-internal-initialization'));

    const fallbackProvenance: MDPreparationProvenance | undefined = store.getSnapshot().draft.structure.preparation?.md;
    expect(fallbackProvenance?.native?.seedTreatment).toBe('native-internal-initialization');
    expect(nativeMDRequiresFormat8(fallbackProvenance?.native)).toBe(true);

    // 2. 6.8.0 rejects 'native-internal-initialization' and accepts 'verified' with matching effectiveSeed
    await controller.start('md', { method: 'gfn2', temperatureK: 300, seed: 6800 });
    const req2 = lastStart!.request;
    const sid2 = lastStart!.sessionId;
    const nextStruct2 = structuredClone(req2.structure);
    nextStruct2.atoms[1].x = 0.76;
    emit(makeNativeEvent(req2, sid2, 1, 'frame', '6.8.0', 'native-internal-initialization', nextStruct2));
    expect(controller.getSnapshot().status).toBe('error');
    expect(controller.getSnapshot().error).toContain('原生MD随机初始化回执不匹配');
    await controller.waitForTermination(sid2);

    await controller.start('md', { method: 'gfn2', temperatureK: 300, seed: 6800 });
    const req3 = lastStart!.request;
    const sid3 = lastStart!.sessionId;
    emit(makeNativeEvent(req3, sid3, 1, 'frame', '6.8.0', 'verified', nextStruct2, 6800));
    emit(makeNativeEvent(req3, sid3, 2, 'stopped', '6.8.0', 'verified', undefined, 6800));

    const verifiedProvenance: MDPreparationProvenance | undefined = store.getSnapshot().draft.structure.preparation?.md;
    expect(verifiedProvenance?.native?.seedTreatment).toBe('verified');
    expect(verifiedProvenance?.native?.effectiveSeed).toBe(6800);
    controller.dispose();
  });
});
