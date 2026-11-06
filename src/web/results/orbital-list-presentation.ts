import type { WavefunctionMetadata, WavefunctionOrbital } from '../../results/orbital-contracts';
import { formatResultValue } from '../../results/numeric-format';

export interface OrbitalListChannel { spin: WavefunctionOrbital['spin']; label: string; rows: WavefunctionOrbital[]; homoKey: string | null; lumoKey: string | null; degenerateKeys: Set<string> }
/** Align independent spin data by displayed source index, never by energy/frontier rank. */
export function alignedOrbitalRows(channels:readonly OrbitalListChannel[]):{displayIndex:number;cells:(WavefunctionOrbital|undefined)[]}[] {
  const indices=[...new Set(channels.flatMap(channel=>channel.rows.map(row=>row.displayIndex)))].sort((a,b)=>b-a);
  const maps=channels.map(channel=>new Map(channel.rows.map(row=>[row.displayIndex,row])));
  return indices.map(displayIndex=>({displayIndex,cells:maps.map(map=>map.get(displayIndex))}));
}
/** Viewport-relative bounds remain valid even when row and host offset parents differ. */
export function orbitalFrontierScrollTop(layout: { hostTop: number; clientTop: number; clientHeight: number; scrollTop: number; scrollHeight: number; targetTop: number; targetHeight: number }): number | null {
  if (layout.clientHeight <= 0 || layout.targetHeight <= 0) return null;
  const centered = layout.scrollTop + layout.targetTop - layout.hostTop - layout.clientTop - (layout.clientHeight - layout.targetHeight) / 2;
  return Math.max(0, Math.min(layout.scrollHeight - layout.clientHeight, centered));
}
export function orbitalListChannels(metadata: Pick<WavefunctionMetadata,'orbitals'>): OrbitalListChannel[] {
  return (['restricted', 'alpha', 'beta'] as const).flatMap(spin => {
    const rows = metadata.orbitals.filter(row => row.spin === spin).sort((a, b) => {
      const aKnown = a.energy != null && Number.isFinite(a.energy), bKnown = b.energy != null && Number.isFinite(b.energy);
      if (aKnown && bKnown) return b.energy! - a.energy! || b.ordinal - a.ordinal;
      return aKnown ? -1 : bKnown ? 1 : b.ordinal - a.ordinal;
    });
    if (!rows.length) return [];
    const occupied = rows.filter(row => row.occupation != null && Number.isFinite(row.occupation) && row.occupation > 0);
    const empty = rows.filter(row => row.occupation === 0);
    const homo = occupied.find(row => row.energy != null) ?? occupied[0];
    const lumo = [...empty].reverse().find(row => row.energy != null) ?? empty.at(-1);
    const energies = new Map<number, WavefunctionOrbital[]>();
    for (const row of rows) if (row.energy != null && Number.isFinite(row.energy)) { const bucket = energies.get(row.energy) ?? []; bucket.push(row); energies.set(row.energy, bucket); }
    const degenerateKeys = new Set([...energies.values()].filter(bucket => bucket.length > 1).flatMap(bucket => bucket.map(row => row.key)));
    return [{ spin, label: spin === 'restricted' ? '' : spin === 'alpha' ? 'α' : 'β', rows, homoKey: homo?.key ?? null, lumoKey: lumo?.key ?? null, degenerateKeys }];
  });
}
/** Electron arrows are a schematic of the printed occupation, not a derived spin assignment. */
export function orbitalElectronMark(occupation: number | null, spin: WavefunctionOrbital['spin'], decimals=2): string {
  if (occupation == null || !Number.isFinite(occupation)) return '?';
  if (occupation === 0) return '';
  if (occupation === 2) return '↑↓';
  if (occupation === 1) return spin === 'beta' ? '↓' : '↑';
  return Number.isInteger(occupation) ? String(occupation) : formatResultValue(occupation,decimals);
}
export const ORBITAL_QUALITY_LEVELS = [
  { id: 'toy', label: '玩具', spacing: .25, relativeTime: .22 },
  { id: 'rough', label: '粗糙', spacing: .20, relativeTime: .42 },
  { id: 'normal', label: '中等', spacing: .15, relativeTime: 1 },
  { id: 'fine', label: '精细', spacing: .10, relativeTime: 3.38 },
  { id: 'art', label: '艺术', spacing: .06, relativeTime: 15.6 },
] as const;
