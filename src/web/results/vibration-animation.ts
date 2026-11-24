import type { Atom, Structure } from '../../core/types';

interface VibrationPose {
  atoms: Atom[];
  angle: number;
}

/** The stable React projection carries the initial pose. Subsequent poses
 * travel only to its active local canvas. The mirrored window retains the
 * serializable projection when the local canvas releases its subscription. */
export function createVibrationAnimation(sample: (phase: number) => Atom[]) {
  const listeners = new Set<(atoms: Atom[]) => void>();
  const poses = new WeakMap<Atom[], VibrationPose>();
  let presented: VibrationPose | undefined;
  return {
    bind(atoms: Atom[], angle: number) {
      if (!listeners.size) presented = undefined;
      poses.set(atoms, { atoms, angle });
    },
    subscribe(listener: (atoms: Atom[]) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(angle: number) {
      if (!listeners.size) return false;
      const atoms = sample(Math.sin(angle));
      poses.set(atoms, { atoms, angle });
      for (const listener of listeners) listener(atoms);
      return true;
    },
    markPresented(atoms: Atom[]) {
      const pose = poses.get(atoms);
      if (pose) presented = pose;
    },
    readPresented: () => presented,
  };
}

const animations = new WeakMap<Atom[], ReturnType<typeof createVibrationAnimation>>();
const staticPoses = new WeakMap<Atom[],{angle:number;presented:boolean}>();

export function bindVibrationAnimation(atoms: Atom[], animation: ReturnType<typeof createVibrationAnimation>, angle: number) {
  animations.set(atoms, animation);
  animation.bind(atoms, angle);
}

export function vibrationAnimationFor(atoms: Atom[] | undefined) {
  return atoms && animations.get(atoms);
}
export function bindStaticVibrationPose(atoms:Atom[],angle:number) {
  staticPoses.set(atoms,{angle,presented:false});
}

export function markStaticVibrationPresented(atoms:Atom[]) {
  const pose=staticPoses.get(atoms);if(pose)pose.presented=true;
}

export function readVibrationPresentedAngle(atoms:Atom[]):number|undefined {
  const animation=vibrationAnimationFor(atoms),staticPose=staticPoses.get(atoms);
  return animation?.readPresented()?.angle??(staticPose?.presented?staticPose.angle:undefined);
}

export function presentedVibrationAtoms(atoms: Atom[] | undefined) {
  return vibrationAnimationFor(atoms)?.readPresented()?.atoms ?? atoms;
}

export function presentedVibrationStructure(structure: Structure): Structure {
  const atoms = presentedVibrationAtoms(structure.atoms);
  return atoms && atoms !== structure.atoms ? { ...structure, atoms } : structure;
}
