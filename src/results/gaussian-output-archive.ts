/** Gaussian records, shared by identity recognition and both output readers. */
export const gaussianJobLink = /^\s*Link1:\s+Proceeding to internal job step number\s+([1-9]\d*)\.\s*$/;
export const gaussianExplicitLink = /^\s*--Link1--\s*$/;
export const gaussianEntry = /^\s*Entering Gaussian System(?:\s*,\s*Link\s+0=.+)?\s*$/;
export const gaussianInitialCommand = /^\s*Initial command\s*:\s*$/i;
export const gaussianNormalTermination = /^\s*Normal termination of Gaussian(?:\s+\d{2,4})?(?:\s+at\s+[^\\|]+\.)?\s*$/;
export const gaussianErrorTermination = /^\s*Error termination(?:\s+(?:via Lnk1e(?:\s+in\s+.+)?|request processed by link\s+\d+.*))?\s*$/i;
const separator = /^\s*-{3,}\s*$/;
const routeStart = /^\s*#[pnt]?(?:\s|$)/i;
const isRouteStart = (text: string) => routeStart.test(text) && !/^\s*#\s+OF\b/i.test(text);
const gaussianCoordinates = /^\s*(?:Symbolic Z-matrix\s*:|(?:Input|Standard|Z-Matrix) orientation\s*:)\s*$/i;
const gaussianState = /^\s*Charge\s*=\s*[+-]?\d+\s+Multiplicity\s*=\s*\d+\b/i;
const version = /^\s*Gaussian\s+\d{2,4}\s*:/i;

type TextLine = { text: string };
type Title<T> = { first: T; text: string | null };
export type GaussianOutputSection<T> =
  | { kind: 'body' | 'route-start'; line: T }
  | { kind: 'title' | 'title-limited'; line: T; text: string | null }
  | { kind: 'route'; line: T; end: T; text: string | null };

/** Title echo is only proven by the closing dash and the following native
 * input-state record. Once text retention is exhausted, keep classifying the
 * region without replaying the discarded candidate as native output. */
class GaussianOutputTitle<T extends TextLine> {
  private pending: T[] = [];
  private opening: T | null = null;
  private first: T | null = null;
  private closing: T | null = null;
  private afterClosing: T[] = [];
  private characters = 0;
  private limited = false;
  private eligible = true;

  private body(line: T, emit: (line: T) => void): void {
    const text = line.text;
    if (gaussianEntry.test(text) || gaussianInitialCommand.test(text) || version.test(text) || gaussianJobLink.test(text) || gaussianExplicitLink.test(text)) this.eligible = true;
    else if (gaussianCoordinates.test(text) || gaussianState.test(text)) this.eligible = false;
    emit(line);
  }
  private clear(): void {
    this.pending = [];
    this.opening = this.first = this.closing = null;
    this.afterClosing = [];
    this.characters = 0;
    this.limited = false;
  }
  beginJob(): void { this.eligible = true; }

  consume(line: T, body: (line: T) => void, title: (title: Title<T>, proven: boolean) => void, expectRoute: boolean): void {
    const text = line.text;
    if (!this.opening) {
      if (this.eligible && separator.test(text)) this.opening = line;
      this.body(line, body);
      return;
    }
    if (expectRoute && !this.first && !this.closing && isRouteStart(text)) {
      this.clear();
      this.body(line, body);
      return;
    }
    if (this.closing) {
      if (/^\s*Symbolic Z-matrix\s*:/i.test(text) || gaussianState.test(text)) {
        if (this.first) title({ first: this.first, text: this.limited ? null : this.pending.map(row => row.text).join('\n') }, true);
        this.clear();
        this.eligible = false;
        this.body(line, body);
        return;
      }
      if (!text.trim()) {
        if (this.afterClosing.length < 8) this.afterClosing.push(line);
        return;
      }
      const closing = this.closing, blanks = this.afterClosing;
      this.finish(body, title, false);
      if (this.eligible) this.opening = closing;
      this.body(closing, body);
      for (const blank of blanks) this.body(blank, body);
      this.consume(line, body, title, expectRoute);
      return;
    }
    if (separator.test(text)) {
      this.closing = line;
      return;
    }
    this.first ??= line;
    if (this.limited) return;
    this.characters += text.length;
    if (this.pending.length >= 128 || this.characters > 8192) {
      this.limited = true;
      this.pending = [];
    } else {
      this.pending.push(line);
    }
  }
  finish(body: (line: T) => void, title: (title: Title<T>, proven: boolean) => void, includeClosing = true): void {
    if (this.limited && this.first) title({ first: this.first, text: null }, false);
    else for (const line of this.pending) this.body(line, body);
    if (includeClosing && this.closing) {
      this.body(this.closing, body);
      for (const line of this.afterClosing) this.body(line, body);
    }
    this.clear();
  }
}

/** Decode record boundaries without interpreting methods, tasks or coordinates.
 * Native tokens inside an Archive, route or proven title never reach body
 * consumers. A wrapped route is joined exactly once, at its closing separator. */
export class GaussianOutputSections<T extends TextLine> {
  private archive: '\\' | '|' | null = null;
  private archiveLink: { line: T; route: T[]; closed: boolean } | null = null;
  private archiveEntry: T[] = [];
  private archiveCloseout = 0;
  private title = new GaussianOutputTitle<T>();
  private sawRoute = false;
  private route: { first: T; last: T; lines: string[] } | null = null;
  get openRoute(): T | null { return this.route?.first ?? null; }

  private finishRoute(emit: (section: GaussianOutputSection<T>) => void, complete: boolean): void {
    const route = this.route;
    if (!route) return;
    this.route = null;
    emit({ kind: 'route', line: route.first, end: route.last, text: complete ? route.lines.join('\n') : null });
  }
  private emitTitle(title: Title<T>, proven: boolean, emit: (section: GaussianOutputSection<T>) => void): void {
    emit({ kind: proven ? 'title' : 'title-limited', line: title.first, text: title.text });
  }
  private clearArchive(): void {
    this.archive = this.archiveLink = null;
    this.archiveEntry = [];
    this.archiveCloseout = 0;
  }
  private archiveBoundary(line: T): T[] | null {
    const text = line.text;
    // A new invocation needs its native startup envelope, not just a banner.
    if (gaussianEntry.test(text)) {
      this.archiveEntry = [line];
    } else if (this.archiveEntry.length) {
      if (gaussianInitialCommand.test(text) || version.test(text)) return this.archiveEntry;
      if (this.archiveEntry.length < 3 && /^\s*(?:Input|Output)=\S/.test(text)) this.archiveEntry.push(line);
      else this.archiveEntry = [];
    }
    if (gaussianJobLink.test(text) || gaussianExplicitLink.test(text)) {
      this.archiveLink = { line, route: [], closed: false };
      return null;
    }
    const link = this.archiveLink;
    if (!link) return null;
    if (!link.route.length) {
      if (isRouteStart(text)) link.route.push(line);
      else if (text.trim() && !separator.test(text)) this.archiveLink = null;
    } else if (!link.closed) {
      link.route.push(line);
      link.closed = separator.test(text) || !text.trim();
    } else if (gaussianState.test(text) || gaussianCoordinates.test(text) || /^\s*\d{1,2}\/[^;]*;\s*$/.test(text)) {
      return [link.line, ...link.route];
    } else if (text.trim()) {
      this.archiveLink = null;
    }
    return null;
  }
  private body(line: T, emit: (section: GaussianOutputSection<T>) => void): void {
    const text = line.text;
    if (this.archive) {
      if (text.trimEnd().endsWith(this.archive.repeat(2) + '@')) {
        this.clearArchive();
        return;
      }
      // A truncated Archive can precede a native closeout. Require the timing
      // and file lengths records before promoting the otherwise ambiguous footer.
      const hasCloseout = this.archiveCloseout === 2 && (gaussianNormalTermination.test(text) || gaussianErrorTermination.test(text));
      if (/^\s*Job cpu time:\s+\d+ days\s+\d+ hours\s+\d+ minutes\s+[\d.]+ seconds\.\s*$/i.test(text)) this.archiveCloseout = 1;
      else if (this.archiveCloseout > 0 && /^\s*File lengths \(MBytes\):\s+RWF=\s*\d+\s+Int=\s*\d+\s+D2E=\s*\d+\s+Chk=\s*\d+\s+Scr=\s*\d+\s*$/i.test(text)) this.archiveCloseout = 2;
      else if (!/^\s*Elapsed time:\s+\d+ days\s+\d+ hours\s+\d+ minutes\s+[\d.]+ seconds\.\s*$/i.test(text)) this.archiveCloseout = 0;
      const restart = this.archiveBoundary(line);
      if (!hasCloseout && !restart) return;
      this.clearArchive();
      if (restart) {
        this.title.beginJob();
        for (const row of restart) this.consume(row, emit);
        this.consume(line, emit);
        return;
      }
    }
    if (this.route) {
      if (separator.test(text) || !text.trim()) this.finishRoute(emit, true);
      else if (gaussianCoordinates.test(text) || gaussianState.test(text) || /^\s*(?:NAtoms\s*=|QPErr\s+---)/i.test(text)
        || gaussianNormalTermination.test(text) || gaussianErrorTermination.test(text) || gaussianJobLink.test(text)
        || gaussianExplicitLink.test(text) || gaussianEntry.test(text) || gaussianInitialCommand.test(text)) this.finishRoute(emit, false);
      else {
        this.route.last = line;
        this.route.lines.push(text.trim());
        return;
      }
    }
    const start = text.match(/^\s*1([\\|])1\1/);
    if (start) {
      const delimiter = start[1] as '\\' | '|';
      if (!text.trimEnd().endsWith(delimiter.repeat(2) + '@')) { this.archive = delimiter; this.archiveCloseout = 0; }
      return;
    }
    if (isRouteStart(text)) {
      this.sawRoute = true;
      this.route = { first: line, last: line, lines: [text.trim()] };
      emit({ kind: 'route-start', line });
    } else {
      if (gaussianEntry.test(text) || gaussianInitialCommand.test(text) || gaussianJobLink.test(text) || gaussianExplicitLink.test(text)) this.sawRoute = false;
      emit({ kind: 'body', line });
    }
  }
  consume(line: T, emit: (section: GaussianOutputSection<T>) => void): void {
    if (this.archive || this.route) this.body(line, emit);
    else this.title.consume(line, row => this.body(row, emit), (title, proven) => this.emitTitle(title, proven, emit), !this.sawRoute);
  }
  finish(emit: (section: GaussianOutputSection<T>) => void): void {
    this.title.finish(row => this.body(row, emit), (title, proven) => this.emitTitle(title, proven, emit));
    this.finishRoute(emit, false);
  }
}

/** Classify an already retained LOG without changing its original source text. */
export function gaussianOutputBodyText(lines: readonly string[]): string[] {
  const sections = new GaussianOutputSections<TextLine>();
  const body: string[] = [];
  const collect = (section: GaussianOutputSection<TextLine>) => {
    if (section.kind === 'body') body.push(section.line.text);
  };
  for (const text of lines) sections.consume({ text }, collect);
  sections.finish(collect);
  return body;
}
