import type { ResultNumberFormat } from './numeric-format';

export type ScatterScaleTickMode = 'ends' | 'automatic' | 'custom';
export type ScatterScaleBounds = readonly [number, number];

export interface ScatterScaleMapping {
  range: ScatterScaleBounds;
  colors: readonly string[];
  zeroCentered?: boolean;
  logarithmic?: boolean;
}

export interface ScatterScaleTitle {
  content: string;
  visible: boolean;
  font?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  dx?: number;
  dy?: number;
}

export interface ScatterColorScaleValue extends ScatterScaleMapping {
  direction: 'horizontal' | 'vertical';
  /** Length as a percentage of the plotting region along the active axis. */
  length: number;
  thickness: number;
  /** Offset from the layout anchor, as a fraction of the whole canvas. */
  dx: number;
  dy: number;
  font: string;
  numberPt: number;
  ink: string;
  decimals: number;
  numberFormat?: ResultNumberFormat | null;
  tickMode: ScatterScaleTickMode;
  tickCount: number;
  tickValues: readonly number[];
  title: ScatterScaleTitle;
}

export type ScatterScaleAppearance = Partial<Pick<ScatterColorScaleValue,
  'direction'|'length'|'thickness'|'font'|'numberPt'|'ink'|'decimals'|'numberFormat'|'tickCount'>> & {
  tickMode?: Exclude<ScatterScaleTickMode, 'custom'>;
};

/** Keep the mapping source available in consumers that know which scalar colors a point. */
export interface ScatterScaleSource {
  min: number;
  max: number;
  label?: string;
  colors?: readonly string[];
  zeroCentered?: boolean;
  logarithmic?: boolean;
  valueForPoint?(index: number): number;
  mutedForPoint?(index: number): boolean;
  direction?: ScatterColorScaleValue['direction'];
}
