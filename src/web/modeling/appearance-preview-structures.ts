import type { Structure, Vector3 } from '../../core/types';

// Shared camera for built-in and saved caffeine thumbnails.
export const APPEARANCE_THUMBNAIL_CAMERA = [-.06355, -.043154, -.000342, 131.15, .07205, -.04864, .00425, .99621];

// Display fixture from the retained PubChem CID 2519 SDF. Source order and
// explicit bond orders match tests/fixtures/public/appearance/caffeine-pubchem3d.sdf.
const caffeineAtoms = [
  ['O', 0.4700, 2.5688, 0.0006],
  ['O', -3.1271, -0.4436, -0.0003],
  ['N', -0.9686, -1.3125, 0.0000],
  ['N', 2.2182, 0.1412, -0.0003],
  ['N', -1.3477, 1.0797, -0.0001],
  ['N', 1.4119, -1.9372, 0.0002],
  ['C', 0.8579, 0.2592, -0.0008],
  ['C', 0.3897, -1.0264, -0.0004],
  ['C', 0.0307, 1.4220, -0.0006],
  ['C', -1.9061, -0.2495, -0.0004],
  ['C', 2.5032, -1.1998, 0.0003],
  ['C', -1.4276, -2.6960, 0.0008],
  ['C', 3.1926, 1.2061, 0.0003],
  ['C', -2.2969, 2.1881, 0.0007],
  ['H', 3.5163, -1.5787, 0.0008],
  ['H', -1.0451, -3.1973, -0.8937],
  ['H', -2.5186, -2.7596, 0.0011],
  ['H', -1.0447, -3.1963, 0.8957],
  ['H', 4.1992, 0.7801, 0.0002],
  ['H', 3.0468, 1.8092, -0.8992],
  ['H', 3.0466, 1.8083, 0.9004],
  ['H', -1.8087, 3.1651, -0.0003],
  ['H', -2.9322, 2.1027, 0.8881],
  ['H', -2.9346, 2.1021, -0.8849],
] as const;
const caffeineBonds = [
  [0, 8, 2],
  [1, 9, 2],
  [2, 7, 1],
  [2, 9, 1],
  [2, 11, 1],
  [3, 6, 1],
  [3, 10, 1],
  [3, 12, 1],
  [4, 8, 1],
  [4, 9, 1],
  [4, 13, 1],
  [5, 7, 1],
  [5, 10, 2],
  [6, 7, 2],
  [6, 8, 1],
  [10, 14, 1],
  [11, 15, 1],
  [11, 16, 1],
  [11, 17, 1],
  [12, 18, 1],
  [12, 19, 1],
  [12, 20, 1],
  [13, 21, 1],
  [13, 22, 1],
  [13, 23, 1],
] as const;

export const CAFFEINE_APPEARANCE_SAMPLE: Structure = {
  id: 'appearance-caffeine',
  name: '咖啡因',
  format: 'SDF',
  atoms: caffeineAtoms.map(([element, x, y, z], index) => ({id: 'caffeine-' + index, element, x, y, z})),
  bonds: caffeineBonds.map(([a, b, order]) => ({a, b, order})),
  charge: 0, multiplicity: 1, notes: [],
};

// Conventional orthogonal FCC cell from COD 9011604. Translate its four
// lattice sites by a quarter edge to put the whole motif inside the box.
const copperEdge = 3.597;
const quarterEdge = copperEdge / 4;
const copperPositions: Vector3[] = [
  [-quarterEdge,-quarterEdge,-quarterEdge], [-quarterEdge,quarterEdge,quarterEdge],
  [quarterEdge,-quarterEdge,quarterEdge], [quarterEdge,quarterEdge,-quarterEdge],
];
const copperBonds: NonNullable<Structure['bonds']> = [];
for (const [a, site] of copperPositions.entries()) {
  for (let b=a+1; b<copperPositions.length; b++) {
    const offsets = site.map((value, axis) => {
      const sign = Math.sign(value-copperPositions[b][axis]);
      return sign ? [0,sign] : [0];
    });
    // Each pair of distinct sites has four equidistant nearest images.
    for (const i of offsets[0]) for (const j of offsets[1]) for (const k of offsets[2])
      copperBonds.push({a,b,order:1,orderKnown:false,image:[i,j,k]});
  }
}

export const COPPER_APPEARANCE_SAMPLE: Structure = {
  id: 'appearance-copper',
  name: 'Cu 正交晶胞',
  format: 'CIF',
  atoms: copperPositions.map(([x,y,z], index) => ({id:'copper-'+index, element:'Cu', x, y, z})),
  bonds: copperBonds,
  cell: {
    vectors: [[copperEdge,0,0],[0,copperEdge,0],[0,0,copperEdge]],
    pbc: [true,true,true],
    origin: [-copperEdge/2,-copperEdge/2,-copperEdge/2],
  },
  charge: null, multiplicity: null, notes: [],
};
