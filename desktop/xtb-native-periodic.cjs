'use strict';
const { createHash } = require('node:crypto');
const { assert } = require('./security.cjs');

const BOHR_ANGSTROM = 0.529177210903;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const AXES = ['x', 'y', 'z'];
const CELL_TOLERANCE_ANGSTROM = 1e-8;
const FIXED_TOLERANCE_ANGSTROM = 1e-7;
const FIRE_GRADIENT_LIMIT = 1e-4;

function nativeNumber(text) {
  assert(typeof text === 'string' && NUMBER.test(text), 'Invalid native periodic number');
  const value = Number(text.replace(/[dD]/, 'e'));
  assert(Number.isFinite(value), 'Nonfinite native periodic number');
  return value;
}

function nativePeriodicOptimization(request) {
  return Boolean(request.structure.cell) && request.calculation !== 'singlepoint';
}

function periodicCoordinatesInput(request) {
  const bohr = value => (value / BOHR_ANGSTROM).toPrecision(17);
  return ['$coord', ...request.structure.atoms.map(atom => [...AXES.map(axis => bohr(atom[axis])), atom.element].join(' ')),
    '$periodic 3', '$lattice bohr', ...request.structure.cell.vectors.map(vector => vector.map(bohr).join(' ')), '$end', ''].join('\n');
}

function createPeriodicOptimizationChart(request) {
  const [a,b,c]=request.structure.cell.vectors;
  const cross=(u,v)=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const dot=(u,v)=>u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
  const volume=dot(a,cross(b,c));
  assert(Number.isFinite(volume)&&Math.abs(volume)>1e-8,'周期原生优化需要非奇异晶胞。');
  const reciprocal=[cross(b,c),cross(c,a),cross(a,b)].map(row=>row.map(value=>value/volume));
  const epsilon=1e-14; // Native shift_back_abc cell-edge rule.
  const byAtom=new Map(request.structure.atoms.map(atom=>{
    const source=AXES.map(axis=>atom[axis]);
    const image=reciprocal.map(axis=>{
      const fractional=dot(axis,source);
      assert(Number.isFinite(fractional)&&Math.abs(fractional)<2**52,'周期原生优化无法可靠确定整数晶胞镜像。');
      if(Math.abs(fractional-1)<epsilon)return 1;
      return fractional < -epsilon || fractional > 1+epsilon ? Math.floor(fractional) : 0;
    });
    const offset=AXES.map((_,axis)=>image[0]*a[axis]+image[1]*b[axis]+image[2]*c[axis]);
    return [atom.id,{image,offset,wrapped:source.map((value,axis)=>value-offset[axis])}];
  }));
  const images=[...byAtom.entries()].flatMap(([atomId,value])=>value.image.some(Boolean)?[{atomId,image:value.image}]:[]);
  const sourceImagesSha256=createHash('sha256').update(JSON.stringify([...byAtom.entries()].map(([atomId,value])=>[atomId,value.image]))).digest('hex');
  const evidence={schema:'ester-xtb-periodic-coordinate-chart/v1',nativeOriginAngstrom:[0,0,0],projection:'source-atom-lattice-images',
    sourceImagesSha256,nonzeroAtomImageCount:images.length};
  return {byAtom,evidence:includeImages=>includeImages?{...evidence,sourceImages:images}:evidence};
}

function validateCell(vectors, request) {
  assert(vectors.length === 3 && vectors.every((vector, row) => vector.length === 3 && vector.every((value, col) =>
    Math.abs(value - request.structure.cell.vectors[row][col]) <= CELL_TOLERANCE_ANGSTROM)), 'Native optimizer changed the fixed cell');
}

function periodicEvidence(request, version, chart=createPeriodicOptimizationChart(request), includeImages=true) {
  return {sourceCell: request.structure.cell, sourcePbc: request.structure.cell.pbc, effectivePbc: [true, true, true],
    fixedCell: true, optimizer: 'native-fire', optimizerVersion: version, backend: ['gfn1', 'gfn2'].includes(request.method) ? 'tblite' : 'native',
    gradientUnit: 'hartree/bohr', accuracy: 0.01, optimizationLevel: 'extreme',
    coordinateChart:chart.evidence(includeImages)};
}

function acceptedPoint(atom, xyz, fixed, chart) {
  assert(xyz.length === 3 && xyz.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6), 'Invalid periodic xTB position');
  const {wrapped,offset}=chart.byAtom.get(atom.id);
  if (fixed.has(atom.id)) {
    assert(xyz.every((value,i)=>Math.abs(value-wrapped[i])<=FIXED_TOLERANCE_ANGSTROM),'Native optimizer moved a frozen atom in its fixed-cell chart');
    xyz = AXES.map(axis => atom[axis]);
  } else xyz=xyz.map((value,i)=>value+offset[i]);
  assert(xyz.every(value=>Number.isFinite(value)&&Math.abs(value)<=1e6),'Invalid periodic xTB position in the source chart');
  return { id: atom.id, element: atom.element, x: xyz[0], y: xyz[1], z: xyz[2] };
}

function periodicOptimizedCoordinates(text, request, chart=createPeriodicOptimizationChart(request)) {
  const atoms = request.structure.atoms;
  const lines = text.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const offset = atoms.length + 1;
  assert(lines.length === offset + 6 && lines[0].trim() === '$coord' && lines[offset].trim() === '$periodic 3' &&
    lines[offset + 1].trim() === '$lattice bohr' && lines.at(-1).trim() === '$end', 'Invalid complete periodic native coordinate output');
  const bohr = line => line.trim().split(/\s+/).map(value => nativeNumber(value) * BOHR_ANGSTROM);
  validateCell(lines.slice(offset + 2, offset + 5).map(bohr), request);
  const fixed = new Set(request.frozenAtomIds);
  return atoms.map((atom, i) => {
    const fields = lines[i + 1].trim().split(/\s+/);
    assert(fields.length === 4 && fields[3].toLowerCase() === atom.element.toLowerCase(), 'Native periodic atom order changed');
    return acceptedPoint(atom, fields.slice(0, 3).map(value => nativeNumber(value) * BOHR_ANGSTROM), fixed, chart);
  });
}

function createFireTrajectoryParser(request, version, chart=createPeriodicOptimizationChart(request)) {
  const atoms = request.structure.atoms, frameLength = atoms.length + 8;
  const fixed = new Set(request.frozenAtomIds);
  const periodic = periodicEvidence(request, version, chart, false);
  let tail = '', lines = [], frameCount = 0, lastStep = -1;
  function frame() {
    const header = /^\s*energy:\s*(\S+)\s+gnorm:\s*(\S+)\s+xtb:\s+(\S+)\s+\([^\r\n]+\)\s+iter:\s*(\d+)\s*$/i.exec(lines[0]);
    assert(header && header[3] === version, 'Periodic FIRE trajectory lacks the expected native version or cycle');
    const energyHartree = nativeNumber(header[1]), step = Number(header[4]);
    nativeNumber(header[2]); // The trajectory gnorm includes fixed-atom reaction forces.
    assert(Number.isSafeInteger(step) && step > lastStep && step <= request.maxSteps, 'Native FIRE trajectory exceeds or reverses the requested cycle bound');
    const scale = nativeNumber(lines[1].trim());
    assert(scale > 0 && /^Cartesian$/i.test(lines[7].trim()), 'Expected Cartesian periodic FIRE trajectory');
    validateCell(lines.slice(2, 5).map(line => line.trim().split(/\s+/).map(value => scale * nativeNumber(value))), request);
    const elements = lines[5].trim().toLowerCase().split(/\s+/), counts = lines[6].trim().split(/\s+/);
    assert(new Set(elements).size === elements.length && counts.length === elements.length && counts.every(count => /^[1-9]\d*$/.test(count)), 'Invalid FIRE trajectory species inventory');
    const grouped = elements.flatMap((element, i) => {
      const group = atoms.filter(atom => atom.element.toLowerCase() === element);
      assert(group.length === Number(counts[i]), 'Native periodic trajectory species changed');
      return group;
    });
    assert(grouped.length === atoms.length, 'Native periodic trajectory atom count changed');
    const points = new Map(grouped.map((atom, i) => {
      const xyz = lines[i + 8].trim().split(/\s+/).map(value => scale * nativeNumber(value));
      if (frameCount === 0) {
        const {wrapped}=chart.byAtom.get(atom.id);
        assert(step===0&&xyz.every((value,j)=>Math.abs(value-wrapped[j])<=FIXED_TOLERANCE_ANGSTROM),'Native FIRE initial frame changed its wrapped geometry or ordering');
      }
      return [atom.id, acceptedPoint(atom, xyz, fixed, chart)];
    }));
    frameCount++; lastStep = step;
    return { coordinates: atoms.map(atom => points.get(atom.id)), step, stepKind: 'native-fire-cycle', energyHartree, periodic };
  }
  return {
    *push(text) {
      assert(typeof text === 'string', 'Invalid native FIRE trajectory data');
      tail += text;
      let end;
      while ((end = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, end).replace(/\r$/, ''); tail = tail.slice(end + 1);
        assert(Buffer.byteLength(line) <= Math.max(8192, atoms.length * 4), 'Native FIRE trajectory line exceeds its byte bound');
        lines.push(line);
        if (lines.length === frameLength) { const complete=frame(); lines = []; yield complete; }
      }
    },
    finish() {
      assert(frameCount > 0 && !tail.length && !lines.length, 'Native FIRE trajectory has missing or partial frames');
      return frameCount;
    },
    count: () => frameCount,
  };
}

module.exports = {nativePeriodicOptimization, periodicCoordinatesInput, periodicOptimizedCoordinates, periodicEvidence, createPeriodicOptimizationChart,
  createFireTrajectoryParser, FIRE_GRADIENT_LIMIT};
