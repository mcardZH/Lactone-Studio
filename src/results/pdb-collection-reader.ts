import { plainPdbAtom, plainPdbStructure } from '../core/parsers';
import { periodicPdbAtom, periodicPdbHeader, periodicPdbStructure } from '../core/periodic-parsers';
import { assertResultNotAborted, type ResultFrameSummary, type ResultInputFile, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { materializePackedTrajectoryFrame, packedTrajectoryAtomId, PackedTrajectoryFrames, registerPackedTrajectorySource, type PackedTrajectoryAtom, type PackedTrajectoryFrame } from './packed-trajectory-source';
import { createTrajectoryOperationBatch } from './trajectory-operations';
import { consumeTrajectoryText, ownTrajectoryText, type TrajectoryTextLine } from './trajectory-text-reader';

interface PdbAtomDescriptor extends PackedTrajectoryAtom { serial: string; alternate: string }
interface PdbTopology { descriptors: readonly PdbAtomDescriptor[]; atoms: readonly PackedTrajectoryAtom[]; serialsUnique: boolean; serials:readonly string[] }

const atomRecord = /^(?:ATOM  |HETATM)/;
const cellRecord = /^(?:CRYST1|SCALE[123](?:\s|$))/;
const modelStart = /^MODEL\s/;
const modelEnd = /^ENDMDL\b/;

class ModelCoordinates {
  readonly alternates = new Set<string>();
  private changed: PdbAtomDescriptor[] | undefined;
  count = 0;
  coordinates: Float64Array;
  constructor(private readonly prior: readonly PdbAtomDescriptor[] = []) {
    this.coordinates = new Float64Array((prior.length || 256) * 3);
  }

  get atoms(): readonly PdbAtomDescriptor[] {
    return this.changed ?? (this.count === this.prior.length ? this.prior : this.prior.slice(0, this.count));
  }

  add(line: string, periodic: boolean) {
    const atom = periodic ? periodicPdbAtom(line) : plainPdbAtom(line);
    if (!Number.isSafeInteger(atom.sourceIndex)) throw new Error('结构集合原子身份或来源序号无效。');
    const { element, x, y, z, sourceIndex } = atom;
    const serial = line.slice(6, 11).trim();
    const alternate = line[16]?.trim() ?? '';
    if (alternate) this.alternates.add(alternate);
    const row = this.count++, offset = row * 3;
    if (offset >= this.coordinates.length) {
      const next = new Float64Array(this.coordinates.length * 2);
      next.set(this.coordinates);
      this.coordinates = next;
    }
    this.coordinates[offset] = x; this.coordinates[offset + 1] = y; this.coordinates[offset + 2] = z;
    const previous = this.prior[row];
    if (!this.changed && (!previous || element !== previous.element || sourceIndex !== previous.sourceIndex
      || serial !== previous.serial || alternate !== previous.alternate)) this.changed = this.prior.slice(0, row);
    this.changed?.push({ element, sourceIndex, serial, alternate });
  }
}

function modelHeader(global: readonly string[], local: readonly string[]): readonly string[] {
  if (!local.length) return global;
  const localCell = local.some(line => line.startsWith('CRYST1'));
  const localScale = local.some(line => line.startsWith('SCALE'));
  return [...global.filter(line => !(localCell && line.startsWith('CRYST1')) && !((localScale || localCell) && line.startsWith('SCALE'))), ...local];
}

function packedPdbVariants(file: ResultInputFile, model: ModelCoordinates, records: readonly string[], modelIndex: number,
  firstRecord: number, previous: Map<string, PdbTopology>): PackedTrajectoryFrame[] {
  const periodic = records.some(line => cellRecord.test(line));
  const crystal = periodic ? periodicPdbHeader(records, file.name) : undefined;
  const alternates = model.alternates.size ? [...model.alternates] : [''];
  const atoms = model.atoms;
  return alternates.map((alternate, variant) => {
    const index = firstRecord + variant;
    const structure = crystal ? periodicPdbStructure(file.name, modelIndex, alternate, variant, crystal)
      : plainPdbStructure(file.name, modelIndex, alternate, index);
    const selected = alternate ? atoms.filter(atom => !atom.alternate || atom.alternate === alternate) : atoms;
    const original = previous.get(alternate);
    const reuse = original && (original.descriptors === selected || original.descriptors.length === selected.length && original.descriptors.every((atom, i) =>
      atom.element === selected[i].element && atom.sourceIndex === selected[i].sourceIndex && atom.serial === selected[i].serial
      && atom.alternate === selected[i].alternate));
    const serials = reuse ? original.serials : selected.map(atom => atom.serial);
    const topology = reuse ? original : { descriptors: selected, atoms: selected.map(({ element, sourceIndex }) => ({ element, sourceIndex })),
      serials, serialsUnique: new Set(serials).size === selected.length };
    if (periodic && !topology.serialsUnique) throw new Error('来源含重复原子ID。');
    let coordinates = model.coordinates;
    if (selected.length !== atoms.length) {
      coordinates = new Float64Array(selected.length * 3);
      let next = 0;
      for (let row = 0; row < atoms.length; row++) {
        const atom = atoms[row];
        if (!atom.alternate || atom.alternate === alternate) {
          const offset = 3 * row;
          coordinates[next++] = model.coordinates[offset];
          coordinates[next++] = model.coordinates[offset + 1];
          coordinates[next++] = model.coordinates[offset + 2];
        }
      }
    } else if (coordinates.length !== selected.length * 3) coordinates = coordinates.slice(0, selected.length * 3);
    previous.set(alternate, topology);
    const { atoms: _atoms, ...header } = structure;
    const prefix = periodic ? structure.id + ':serial:' : (globalThis.crypto?.randomUUID?.() ?? file.id + ':record:' + index) + ':';
    const atomIds={prefix,...(periodic?{suffixes:topology.serials}:{})};
    return { header: { ...header, id: file.id + ':collection:record:' + index }, topology: topology.atoms,
      coordinates, atomIds, atomId: packedTrajectoryAtomId(atomIds) };
  });
}

/** PDB MODEL order represents a structure collection; it provides no physical clock. */
export async function readPdbCollection(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  const frames: ResultFrameSummary[] = [], packed = new PackedTrajectoryFrames();
  const messages = ['文件内结构集合；记录顺序不代表物理时间，时间与能量未作推断。'];
  let status: TrajectoryResult['status'] = 'completed';
  const previous = new Map<string, PdbTopology>();
  const global: string[] = [];
  let local: string[] = [], current = new ModelCoordinates(), explicit = false, periodic = false, modelIndex = 0, sourceLine = 1;
  const parse = createTrajectoryOperationBatch('parse', { sourceId: file.id, workPhase: 'pdb-index-model' });
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= Promise.resolve().then(() => file.close?.()).then(() => undefined);

  function finishModel() {
    if (current.count) {
      const variants = packedPdbVariants(file, current, modelHeader(global, local), modelIndex++, frames.length, previous);
      for (const frame of variants) {
        frames.push({ index: frames.length, sourceStep: null, time: null, energy: null, convergence: [], sourceLine, label: frame.header.format });
        packed.append(frame);
      }
      current = new ModelCoordinates(current.atoms);
    }
    local = [];
    explicit = false;
    periodic = global.some(line => cellRecord.test(line));
  }

  function consume(line: TrajectoryTextLine) {
    const text = line.text;
    if (modelStart.test(text)) {
      if (explicit) throw new Error('PDB MODEL缺少ENDMDL，模型截断。');
      if (current.count) finishModel();
      explicit = true;
      sourceLine = line.number;
    } else if (modelEnd.test(text) || !explicit && /^END\s*$/.test(text)) {
      finishModel();
    } else if (atomRecord.test(text)) {
      if (!explicit && !current.count && frames.length) sourceLine = line.number;
      current.add(text, periodic);
    } else if (cellRecord.test(text) || text.startsWith('EXPDTA')) {
      (explicit ? local : global).push(ownTrajectoryText(text));
      if (cellRecord.test(text)) periodic = true;
    }
  }

  try {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('结构集合文件字节数无效。');
    try {
      await consumeTrajectoryText(file, options, line => parse.run(() => consume(line)),()=>packed.drain());
      assertResultNotAborted(options.signal);
      if (explicit) throw new Error('PDB MODEL缺少ENDMDL，模型截断。');
      finishModel();
    } catch (error) {
      assertResultNotAborted(options.signal);
      if (!frames.length) throw error;
      status = /截断|不完整/.test(String(error)) ? 'incomplete' : 'failed';
      messages.push('第' + sourceLine + '行开始的记录未读取；保留此前' + frames.length + '个完整结构：'
        + (error instanceof Error ? error.message : String(error)));
    } finally { parse.flush(); }
    if (!frames.length) throw new Error('结构集合中没有完整结构。');
    try{await packed.seal();}catch(error){status='failed';messages.push('结构集合暂存未完成；保留可用坐标：'+(error instanceof Error?error.message:String(error)));}
    current = new ModelCoordinates(); previous.clear(); local = []; global.length = 0;
    let disposed = false;
    const result: TrajectoryResult = {
      id: file.id + ':collection', label: file.name, kind: 'collection', engine: 'structure', source: { id: file.id, name: file.name, size: file.size },
      jobIndex: 0, status, messages, frames, initialStructure: materializePackedTrajectoryFrame((await packed.read(0))!),
      async getFrame(index, signal) {
        assertResultNotAborted(signal);
        if (disposed) throw new Error('结构集合已关闭。');
        if (!Number.isSafeInteger(index) || index < 0 || index >= packed.length) throw new Error('集合记录索引超出范围。');
        return materializePackedTrajectoryFrame((await packed.read(index,signal))!);
      },
      async dispose() { disposed = true;await packed.dispose();await close(); },
    };
    registerPackedTrajectorySource(result, packed.get, {read:packed.read,paged:packed.paged,canonical:true});
    return [result];
  } catch (error) { await Promise.allSettled([packed.dispose(),close()]);throw error; }
}
