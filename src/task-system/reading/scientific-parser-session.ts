import { GaussianScientificParser } from '../../results/gaussian-scientific-parser';
import { OrcaScientificParser } from '../../results/orca-scientific-parser';
import type { ScientificParserSnapshot } from '../../results/scientific-contracts';
import { outputSoftwareOnLine } from '../../results/source-recognition';
import type { IncrementalParserSession, MonitorLine, ParserProjection } from './contracts';

/** Header recognition and G/O selection only; all scientific grammar stays in results/. */
export class ScientificMonitoringSession implements IncrementalParserSession<ScientificParserSnapshot> {
  private parser: GaussianScientificParser | OrcaScientificParser | null = null;
  private engine: 'gaussian' | 'orca' | null = null;
  private header: MonitorLine[] = [];
  private ended = false;
  private disposed = false;
  consume(line: MonitorLine): void {
    if (this.disposed || this.ended) throw new Error('持续科学会话已关闭或终结。');
    const engine = outputSoftwareOnLine(line.text);
    if (engine && engine !== 'gaussian' && engine !== 'orca') throw new Error('此来源不是已支持的Gaussian/ORCA输出。');
    if (engine && this.engine && engine !== this.engine) throw new Error('来源后续出现不同软件身份；未混接科学作业。');
    if (!this.parser) {
      this.header.push(line);
      if (engine) {
        this.engine = engine;
        this.parser = engine === 'gaussian' ? new GaussianScientificParser(undefined, true) : new OrcaScientificParser(undefined, true);
        for (const row of this.header) this.parser.consume(row);
        this.header = [];
      }
      return;
    }
    this.parser.consume(line);
  }
  private projection(): ParserProjection<ScientificParserSnapshot> | null {
    if (!this.parser) return null;
    const value = this.parser.peek();
    return value.jobs.length ? { value, version: value.version, publishedByteEnd: value.publishedByteEnd } : null;
  }
  snapshot(): ParserProjection<ScientificParserSnapshot> | null {
    if (this.disposed) throw new Error('持续科学会话已关闭。');
    return this.projection();
  }
  final(): ParserProjection<ScientificParserSnapshot> | null {
    if (this.disposed) throw new Error('持续科学会话已关闭。');
    if (!this.ended) { this.parser?.finish(); this.ended = true; }
    return this.projection();
  }
  dispose(): void { this.disposed = true; this.parser = null; this.header = []; }
}
