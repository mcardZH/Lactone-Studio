/** Coordinate folding affects presentation only, never formatter output. */
export function foldInputCoordinates(text: string, atomCount: number): string {
  if (!atomCount) return text;
  const lines = text.split('\n');
  const number = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[EeDd][-+]?\\d+)?';
  const row = new RegExp('^\\s*[A-Z][a-z]?(?:\\(Fragment=\\d+\\))?\\s+(?:-1\\s+)?'+number+'\\s+'+number+'\\s+'+number+'(?:\\s+.*)?$');
  const start = lines.findIndex(line => row.test(line));
  if (start < 0) return text;
  let end = start; while (end < lines.length && row.test(lines[end])) end++;
  if (end-start !== atomCount) return text;
  return [...lines.slice(0,start), `<${atomCount} 个原子坐标已折叠，仅影响预览>`, ...lines.slice(end)].join('\n');
}
