import {DismissibleNotice} from '../DismissibleNotice';
import { useRef, useState } from 'react';
import type { HirshfeldContactRow } from '../../results/hirshfeld-contracts';
import { hirshfeldContactKey, hirshfeldContactLabel, type HirshfeldContactFocus } from '../../results/hirshfeld-presentation';
import { useScientificPlotSize } from './ScientificPlotSize';
import { ScientificPlotExportMenu } from './ScientificPlotExportMenu';
import { exportBlob } from './export-image';
import { optimizationSvgPng, serializeOptimizationSvg } from './optimization-export';
import { ScientificPlotSettings, plotFontFamily, plotPt, usePlotAppearance, usePlotFont } from './ScientificPlotSettings';

// fig-272's Spectral sequence, including both endpoint colors.
const colors = ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'];
function contactColor(index: number, count: number) {
  const position = count <= 1 ? 0 : index / (count - 1) * (colors.length - 1), left = Math.floor(position), right = Math.min(colors.length - 1, left + 1), fraction = position - left;
  const channels = [1, 3, 5].map(offset => Math.round(parseInt(colors[left].slice(offset, offset + 2), 16) * (1 - fraction) + parseInt(colors[right].slice(offset, offset + 2), 16) * fraction));
  return `rgb(${channels.join(',')})`;
}
const wrapLabel = (text: string, width: number, fontSize: number) => {
  const lines: string[] = []; let line = '', used = 0;
  for (const char of text) { const advance = /[^\u0000-\u00ff]/u.test(char) ? fontSize : fontSize * .6; if (line && used + advance > width) { lines.push(line); line = ''; used = 0; } line += char; used += advance; }
  if (line || !lines.length) lines.push(line); return lines;
};
/** Native whole-surface percentages, without rounding to 100 or regrouping tiny contacts. */
export default function HirshfeldContactContribution({ rows, merged, decimals, onContact, appearanceKey }: {
  rows: readonly HirshfeldContactRow[]; merged: boolean; decimals: number; onContact(value: HirshfeldContactFocus): void; appearanceKey?: string;
}) {
  const plot = useScientificPlotSize(), svg = useRef<SVGSVGElement>(null), [error, setError] = useState('');
  usePlotFont(svg.current?.ownerDocument);
  const appearance = usePlotAppearance(appearanceKey), a = appearance.value;
  const positive = rows.filter(row => row.area > 0 && Number.isFinite(row.area) && Number.isFinite(row.nativePercent)), width = plot.width;
  const title = '接触面积贡献', titleText = a.title ?? title, legendSize = plotPt(a.legendSize), titleSize = plotPt(a.titleSize);
  const names = positive.map(row => ({ id: hirshfeldContactKey(row.insideElement, row.outsideElement, merged), label: hirshfeldContactLabel({ ...row, merged }) }));
  const legendX = width * .64, legendWidth = Math.max(30, width - legendX - 18), labelWidth = Math.max(18, legendWidth - 17);
  const entries = positive.map((row, index) => {
    const focus = { insideElement: row.insideElement, outsideElement: row.outsideElement, merged }, label = appearance.name(names[index].id, names[index].label);
    const percentage = `${row.nativePercent.toFixed(decimals)}%`;
    // Narrow figures move numerical labels to the legend before they cross the hole.
    const small = row.nativePercent < 4 || percentage.length * legendSize * .6 > (width * .29 - 14) * .48;
    return { row, focus, label, percentage, small, color: contactColor(index, positive.length), lines: wrapLabel(small ? `${label}  ${percentage}` : label, labelWidth, legendSize) };
  });
  const lineHeight = legendSize * 1.35, entryHeights = entries.map(entry => Math.max(22, entry.lines.length * lineHeight + 6));
  const legendHeight = entryHeights.reduce((sum, value) => sum + value, 0), height = plot.height ?? Math.max(300, Math.min(width * .78, 440), legendHeight + 72);
  const cx = width * .30, cy = height / 2 + 12, radius = Math.max(15, Math.min(width * .29 - 14, (height - 82) / 2)), inner = radius * .5;
  const totalPercent = positive.reduce((sum, row) => sum + row.nativePercent, 0);
  let angle = -Math.PI / 2, legendY = Math.max(54, cy - legendHeight / 2);
  const slices = entries.map((entry, index) => { const start = angle; angle += entry.row.nativePercent / 100 * Math.PI * 2;
    const result = { ...entry, start, end: angle, mid: (start + angle) / 2, legendY }; legendY += entryHeights[index]; return result; });
  const exportChart = async (kind: 'svg' | 'png') => { const node = svg.current; if (!node) return; try { const text = serializeOptimizationSvg(node);
    exportBlob(kind === 'png' ? await optimizationSvgPng(text, node.ownerDocument) : new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), `Ester-Studio-hirshfeld-contributions.${kind}`, node.ownerDocument); setError('');
  } catch (value) { setError(String(value instanceof Error ? value.message : value)); } };
  return <div className="scientific-plot hirshfeld-contribution-plot"><div className="scientific-plot-toolbar">{plot.controls(height)}
    <ScientificPlotExportMenu options={['svg', 'png'].map(kind => ({ key: kind, label: kind.toUpperCase(), run: () => { void exportChart(kind as 'svg' | 'png'); } }))}/></div>
    <ScientificPlotSettings appearance={appearance} title={title} names={names}/>
    {error && <DismissibleNotice>{error}</DismissibleNotice>}<div ref={plot.stageRef} className="scientific-plot-stage" style={plot.style(height)}>{plot.handles}
      <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="原生接触面积贡献图" fontFamily={plotFontFamily(a.font)}>
        <rect width={width} height={height} fill="white"/>
        <metadata>{JSON.stringify({ method: 'native-area', merged, rows, appearance: a })}</metadata>
        <text x={cx} y={30} textAnchor="middle" fontSize={titleSize} fill="#203c50">{titleText}</text>
        {slices.map((slice, index) => { const { start, end, mid, color, focus, label, percentage, small } = slice;
          const point = (r: number, theta: number) => `${cx + r * Math.cos(theta)} ${cy + r * Math.sin(theta)}`;
          const full = end - start >= Math.PI * 2 - 1e-9;
          const d = full ? `M ${point(radius, start)} A ${radius} ${radius} 0 1 1 ${point(radius, start + Math.PI)} A ${radius} ${radius} 0 1 1 ${point(radius, end)} L ${point(inner, end)} A ${inner} ${inner} 0 1 0 ${point(inner, start + Math.PI)} A ${inner} ${inner} 0 1 0 ${point(inner, start)} Z`
            : `M ${point(radius, start)} A ${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${point(radius, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${end - start > Math.PI ? 1 : 0} 0 ${point(inner, start)} Z`;
          return <g key={names[index].id} role="button" tabIndex={0} aria-label={`${label} ${percentage}`} onClick={() => onContact(focus)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onContact(focus); } }} style={{ cursor: 'pointer' }}>
            <path data-contact-slice={names[index].id} d={d} fill={color} stroke={slice.row.nativePercent < 1 ? color : 'white'} strokeWidth={slice.row.nativePercent < 1 ? 0 : 1}/>
            {!small && <text x={cx + radius * .75 * Math.cos(mid)} y={cy + radius * .75 * Math.sin(mid)} dominantBaseline="middle" textAnchor="middle" fontSize={legendSize} fill={(() => { const rgb = color.match(/\d+/g)!.map(Number); return rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 160 ? '#4d4d4d' : 'white'; })()}>{percentage}</text>}
            <rect x={legendX} y={slice.legendY - legendSize * .8} width={11} height={legendSize * .7} fill={color}/>
            <text x={legendX + 18} y={slice.legendY} fontSize={legendSize} fill="black">{slice.lines.map((line, i) => <tspan x={legendX + 18} dy={i ? lineHeight : 0} key={i}>{line}</tspan>)}</text>
            <title>{`${label}: ${percentage}; ${slice.row.area} Å²`}</title>
          </g>;
        })}
        <text x={cx} y={cy - legendSize * .2} textAnchor="middle" fontSize={legendSize * 1.15} fill="black"><tspan x={cx}>合计</tspan><tspan x={cx} dy={legendSize * 1.5}>{totalPercent.toFixed(decimals)}%</tspan></text>
      </svg></div></div>;
}
