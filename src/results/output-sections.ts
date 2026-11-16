import { GaussianOutputSections } from './gaussian-output-archive';

export const orcaNormalTermination = /^\s*\**\s*ORCA TERMINATED NORMALLY\s*\**\s*$/i;

export type OutputSoftware = 'gaussian' | 'orca' | 'cp2k';

export function orcaOutputEcho(text: string): string | undefined {
  return text.match(/^\s*\|\s*\d+>\s?(.*)$/)?.[1];
}
export function orcaOutputComment(text: string): boolean {
  return /^\s*#(?!\s*of atoms\b)/i.test(text);
}
export function orcaPrintedState(text: string) {
  return {
    charge: text.match(/^\s*Total Charge(?:\s+Charge)?\s*[.:=]*\s*([+-]?\d+)\s*$/i),
    multiplicity: text.match(/^\s*Multiplicity(?:\s+Mult)?\s*[.:=]*\s*(\d+)\s*$/i),
  };
}

/** Call only on classified output body text, or before a native engine is known. */
export function outputSoftwareOnLine(raw: string): OutputSoftware | null {
  const line = raw.replace(/^\uFEFF/, '');
  if (/^\s*Entering Gaussian System\b|^\s*Gaussian\s+(?:03|09|16)(?:\s*:|\s*$)/i.test(line)) return 'gaussian';
  if (/^\s*(?:\*\s*)?O\s+R\s+C\s+A\s*\*?\s*$|^\s*ORCA\b[^\n]*\bProgram Version\s+\d+\.\d+/i.test(line)) return 'orca';
  if (/^\s*CP2K\||^\s*CP2K\s+(?:version|VERSION|[0-9]+\.[0-9]+)\b/.test(line)) return 'cp2k';
  return null;
}
export class MixedOutputSoftwareError extends Error {
  constructor() { super('同一来源含不同软件身份；请分别提供原始来源。'); }
}
export function assertOutputSoftware(text: string, expected: OutputSoftware): void {
  const software = outputSoftwareOnLine(text);
  if (software && software !== expected) throw new MixedOutputSoftwareError();
}

/** Recognition reads the same native body as the parsers, including a
 * Gaussian title whose role becomes known only at the following state row. */
export function visitOutputBody<T extends { text: string }>(lines: T[], visit: (line: T) => void, final = true): void {
  const gaussian = new GaussianOutputSections<T>();
  let owner: OutputSoftware | null = null;
  for (const line of lines) {
    owner ??= outputSoftwareOnLine(line.text);
    if (owner === 'gaussian') gaussian.consume(line, section => { if (section.kind === 'body') visit(section.line); });
    else if (orcaOutputEcho(line.text) === undefined && !orcaOutputComment(line.text)) visit(line);
  }
  if (owner === 'gaussian' && final) gaussian.finish(section => { if (section.kind === 'body') visit(section.line); });
}
