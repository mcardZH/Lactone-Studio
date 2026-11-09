import type {AdvancedTaskRecord} from './contracts';

/** A new native initialization record must not disappear in an older writer. */
export function conformerTaskHasInitialVelocityProvenance(task:AdvancedTaskRecord):boolean {
  const recorded=(sampling:AdvancedTaskRecord['runs'][number]['sampling'])=>
    sampling?.terminal?.initialVelocityCorrection!=null
    ||sampling?.terminal?.lastFrame?.nativeMD?.initialVelocityCorrection!=null;
  return task.runs.some(run=>recorded(run.sampling)
    ||run.mixedSampling?.cards.some(card=>recorded(card.sampling))
    ||run.frames.some(frame=>frame.process?.kind==='sampling'&&frame.process.data.nativeMD?.initialVelocityCorrection!=null))
    ||Boolean(task.mixedSampling?.batches?.some(batch=>batch.cards.some(card=>recorded(card.sampling))));
}

/** Verified native solvent readback is also a protected persisted result fact. */
export function conformerTaskHasNativeSolvationProvenance(task:AdvancedTaskRecord):boolean {
  const recorded=(sampling:AdvancedTaskRecord['runs'][number]['sampling'])=>
    sampling?.terminal?.nativeSolvation!=null||sampling?.terminal?.lastFrame?.nativeMD?.nativeSolvation!=null;
  return task.runs.some(run=>recorded(run.sampling)
    ||run.mixedSampling?.cards.some(card=>recorded(card.sampling))
    ||run.frames.some(frame=>frame.process?.kind==='sampling'&&frame.process.data.nativeMD?.nativeSolvation!=null))
    ||Boolean(task.mixedSampling?.batches?.some(batch=>batch.cards.some(card=>recorded(card.sampling))));
}
