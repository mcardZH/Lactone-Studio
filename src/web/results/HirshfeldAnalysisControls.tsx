import {DismissibleNotice} from '../DismissibleNotice';
import MultiwfnErrorNotice from './MultiwfnErrorNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InteractiveSelectionField from '../InteractiveSelectionField';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsLayout } from '../InputSettingsLayout';
import { assertAnalysisSelectionPort } from '../analysis-selection-intent';
import { AnalysisTaskLayout, AnalysisTaskSection, SpatialGridSummary } from './AnalysisTaskLayout';
import { ScientificDataTable } from './ScientificDataTable';
import { scientificTableText } from './scientific-table';
import {hirshfeldContactTable} from './hirshfeld-contact-table';
import {ResultsMcpInlinePlotSource} from './results-mcp-context';
import { formatAnalysisValue } from './analysis-display';
import {prepareHirshfeldDisplayRanges,type HirshfeldDisplayRanges} from './hirshfeld-range-display';
import { hirshfeldContactKey, hirshfeldContactLabel, hirshfeldContactOptions, type HirshfeldContactFocus } from '../../results/hirshfeld-presentation';
import type { HirshfeldAnalysisControlsProps } from './hirshfeld-controls-contracts';
import { initialHirshfeldState } from './hirshfeld-controls-contracts';
import HirshfeldFingerprint, { type HirshfeldPlotExportHandle } from './HirshfeldFingerprint';
import HirshfeldContactContribution from './HirshfeldContactContribution';
import MeshFinishControls from './MeshFinishControls';
import MultiwfnProgress from './MultiwfnProgress';
import { exportBlob } from './export-image';
import AnalysisColorbarLayoutControls from './AnalysisColorbarLayoutControls';
import { ANALYSIS_PALETTES } from './analysis-display';
import SurfaceAppearanceControls from './SurfaceAppearanceControls';
import SaveSurfaceAppearanceDefault from './SaveSurfaceAppearanceDefault';
import { captureHirshfeldAppearance, restoreHirshfeldAppearance } from './surface-appearance-defaults';
import { hirshfeldAppearance } from './surface-appearance';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import { ScientificPlotExportMenu } from './ScientificPlotExportMenu';
import ResultNumberFormatFields from './ResultNumberFormatFields';
import './hirshfeld-analysis.css';

function combinedFingerprintSvg(panels: readonly string[], doc: Document): string {
  const Parser = doc.defaultView?.DOMParser ?? DOMParser, Serializer = doc.defaultView?.XMLSerializer ?? XMLSerializer;
  const roots = panels.map(text => new Parser().parseFromString(text, 'image/svg+xml').documentElement);
  const width = Math.max(...roots.map(node => Number(node.getAttribute('width')))), height = Math.max(...roots.map(node => Number(node.getAttribute('height'))));
  const columns = Math.min(2, roots.length), rows = Math.ceil(roots.length / columns);
  const root = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); root.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); root.setAttribute('width', String(width * columns)); root.setAttribute('height', String(height * rows)); root.setAttribute('viewBox', `0 0 ${width * columns} ${height * rows}`);
  roots.forEach((node, index) => { const copy = doc.importNode(node, true); copy.setAttribute('x', String(index % columns * width)); copy.setAttribute('y', String(Math.floor(index / columns) * height));
    const ids = [...copy.querySelectorAll('[id]')].map(item => item.id);
    for (const id of ids) for (const item of [copy, ...copy.querySelectorAll('*')]) for (const attribute of [...item.attributes]) {
      const value = attribute.value.replaceAll(`url(#${id})`, `url(#panel-${index}-${id})`); item.setAttribute(attribute.name, attribute.name === 'id' && value === id ? `panel-${index}-${id}` : ['href', 'xlink:href'].includes(attribute.name) && value === `#${id}` ? `#panel-${index}-${id}` : value);
    }
    root.appendChild(copy); });
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new Serializer().serializeToString(root);
}
function HirshfeldAnalysisControlsInner(p: HirshfeldAnalysisControlsProps & {displayRanges?:HirshfeldDisplayRanges;mcpAnalysisId?:string}) {
  const s = p.state, result = s.result, locked = p.disabled || p.running;
  const appearanceDefaults=useSurfaceAppearanceDefaults();
  const restorePlotting=()=>{const base=initialHirshfeldState().display,saved=appearanceDefaults.snapshot?.value['surface:hirshfeld'];p.onChange({display:saved && 'colors' in saved ? restoreHirshfeldAppearance(base,saved):base});};
  const display = (patch: Partial<typeof s.display>) => p.onChange({ display: { ...s.display, ...patch } });
  const {rows,table} = useMemo(() => hirshfeldContactTable(s), [s.result,s.merged,s.areaSort,s.areaSortDirection,s.decimals,s.contactNumberFormat]);
  const options = useMemo(() => result ? hirshfeldContactOptions(result, s.merged) : [], [result, s.merged]);
  const focusKey = s.selectedContact ? hirshfeldContactKey(s.selectedContact.insideElement, s.selectedContact.outsideElement, s.merged) : '';
  const [selectedExport, setSelectedExport] = useProjectState<readonly string[]>('HirshfeldAnalysisControls.selectedExport', []), [exporting, setExporting] = useState(false), [exportFocus, setExportFocus] = useState<{ value: HirshfeldContactFocus | null } | null>(null), [exportError, setExportError] = useState('');
  const plotHandle = useRef<HirshfeldPlotExportHandle | null>(null), alive = useRef(true), batch = useRef(0);
  const pendingSnapshot = useRef<{ focus: HirshfeldContactFocus | null; resolve(value: HirshfeldPlotExportHandle): void; reject(reason: Error): void } | null>(null);
  const receiveHandle = useCallback((value: HirshfeldPlotExportHandle | null) => { plotHandle.current = value; const pending = pendingSnapshot.current;
    if (value && pending && JSON.stringify(value.focus) === JSON.stringify(pending.focus)) { pendingSnapshot.current = null; pending.resolve(value); }
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; batch.current++; pendingSnapshot.current?.reject(new Error('指纹导出窗口已关闭。')); pendingSnapshot.current = null; }; }, []);
  useEffect(() => { batch.current++; pendingSnapshot.current?.reject(new Error('指纹来源已切换。')); pendingSnapshot.current = null; setExporting(false); setExportFocus(null); setSelectedExport([]); }, [result?.stamp.requestId, p.disabled]);
  const exportPlots = async (kind: 'all' | 'combined') => {
    const initial = plotHandle.current; if (!initial || !result || exporting) return;
    const own = ++batch.current, targets = [null, ...options.filter(focus => kind === 'all' || selectedExport.includes(hirshfeldContactKey(focus.insideElement, focus.outsideElement, s.merged)))];
    setExporting(true); setExportError(''); const panels: string[] = [];
    try {
      for (const focus of targets) {
        if (!alive.current || own !== batch.current) return;
        const ready = new Promise<HirshfeldPlotExportHandle>((resolve, reject) => { pendingSnapshot.current = { focus, resolve, reject }; });
        setExportFocus({ value: focus });
        const handle = await ready;
        if (!alive.current || own !== batch.current) return;
        const text = await handle.snapshotSvg(); if (!alive.current || own !== batch.current) return;
        if (kind === 'combined') panels.push(text); else exportBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), `Ester-Studio-hirshfeld-${focus ? `${focus.insideElement}-i-${focus.outsideElement}-e` : 'total'}.svg`, handle.ownerDocument);
      }
      if (kind === 'combined') exportBlob(new Blob([combinedFingerprintSvg(panels, initial.ownerDocument)], { type: 'image/svg+xml;charset=utf-8' }), 'Ester-Studio-hirshfeld-combined.svg', initial.ownerDocument);
    } catch (error) { if (alive.current && own === batch.current) setExportError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current && own === batch.current) { setExportFocus(null); setExporting(false); } }
  };
  const ranges = p.displayRanges ?? prepareHirshfeldDisplayRanges(s, p.context, p.structure);
  const actualGrid = ranges.actual?.grid, estimated = ranges.estimate;
  const rangeIssue = s.showRange ? ranges.issue || s.rangeError : '';
  return <section aria-label="Hirshfeld表面与指纹" data-testid="hirshfeld-analysis-controls"><InputSettingsLayout>
    <AnalysisTaskLayout variant="card" title="Hirshfeld表面与指纹" className="hirshfeld-analysis-card" qualityDisabled={locked} onRestoreQuality={()=>{const defaults=initialHirshfeldState();p.onChange({mode:defaults.mode,spacingBohr:defaults.spacingBohr,showRange:defaults.showRange});}} setup={<>
      <div className="hirshfeld-target-selection">{p.capturePort ? <InteractiveSelectionField structure={p.structure} label="目标片段" rowId="hirshfeld-target" atomIds={s.targetIds} kind="atoms" disabled={locked || !!p.sourceError}
        captureOwner={p.capturePort.owner} contextKey={p.capturePort.contextKey} analysisPurpose="hirshfeld-target"
        remainingAtomIds={p.structure.atoms.flatMap(atom => atom.id && !s.targetIds.includes(atom.id) ? [atom.id] : [])}
        onClear={() => p.onChange({ targetIds: [], error: '' })} clearDisabled={!s.targetIds.length}
        onRequestAnalysisSelection={intent => { assertAnalysisSelectionPort(p.capturePort!); return p.capturePort!.requestSelection(intent); }}
        onConfirm={(ids, guard) => { assertAnalysisSelectionPort(p.capturePort!); guard(); p.onChange({ targetIds: ids, error: '' }); }}/>
        : <p role="status">片段选择尚未就绪。</p>}
      <output className="hirshfeld-target-summary">目标 {s.targetIds.length} 个原子 · 环境 {p.structure.atoms.length - s.targetIds.length} 个原子</output></div>
      {p.sourceError && <DismissibleNotice className="postprocess-warning">{p.sourceError}</DismissibleNotice>}
    </>} quality={<>
      <InputSettingsRow><InputSettingsField label="计算模式"><select aria-label="Hirshfeld计算模式" value={s.mode} disabled={locked} onChange={event => p.onChange({ mode: event.currentTarget.value as typeof s.mode })}><option value="closed">完整闭合表面</option><option value="open-preview">开放接触面预览</option></select></InputSettingsField>
        <InputSettingsField label="网格间距 / Bohr"><NumericInput aria-label="Hirshfeld网格间距"  min={.05} max={1} step={.05} value={s.spacingBohr} disabled={locked}
          onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= .05 && value <= 1) p.onChange({ spacingBohr: value }); }}/></InputSettingsField>
        <InputSettingsCheckbox label="显示计算范围" checked={s.showRange} onChange={showRange => p.onChange({ showRange })}/></InputSettingsRow>
      {rangeIssue && <DismissibleNotice identity={projectUiSourceIdentity(p)}>Hirshfeld范围暂无法显示。{rangeIssue}</DismissibleNotice>}
      {s.showRange && !rangeIssue && <output>{!actualGrid && s.rangeExtensionBohr === null ? '计算范围待读取' : !ranges.resultMatchesDraft || !actualGrid ? '显示预计范围；已有结果保留实际范围' : '显示实际计算范围'}</output>}
      <SpatialGridSummary preview={estimated ? { dimensions: estimated.grid.dimensions, pointCount: estimated.grid.dimensions.reduce((a, b) => a * b, 1), axisSpacingBohr: estimated.grid.axes.map(axis => Math.hypot(...axis)), estimated: true } : null}
        actual={actualGrid ? { dimensions: actualGrid.dimensions, pointCount: actualGrid.dimensions.reduce((a, b) => a * b, 1), axisSpacingBohr: actualGrid.axes.map(axis => Math.hypot(...axis) * (actualGrid.coordinateUnit === 'angstrom' ? 1 / .529177210903 : 1)), estimated: false } : null}/>
    </>} actions={<><InputSettingsAction variant="primary" disabled={locked || !!p.sourceError || !!p.resourceError || !p.resourceDefaults || !p.capturePort || !s.targetIds.length || s.targetIds.length >= p.structure.atoms.length} onClick={p.onCalculate}>计算</InputSettingsAction>
      <output>沿全局计算资源</output>
      {p.sessionInfo && <details className="analysis-method-details hirshfeld-resource-record"><summary>资源记录</summary>
        <output aria-label="Hirshfeld会话资源">{p.sessionInfo.resourceSnapshot === 'open-grant' ? '打开会话资源' : s.grantPresentation === 'current' ? '本次运行资源' : '上次运行资源'}：线程 {p.sessionInfo.resources.threads}</output>
        <output>配置预算 {formatAnalysisValue(p.sessionInfo.resources.configuredMemoryBudgetBytes / 1024 ** 3, 2)} GiB（{p.sessionInfo.resources.configuredMemoryBudgetBytes} B） · 共享占用 {formatAnalysisValue(p.sessionInfo.resources.sharedReservedBytes / 1024 ** 3, 2)} GiB（{p.sessionInfo.resources.sharedReservedBytes} B） · 可用预算 {formatAnalysisValue(p.sessionInfo.resources.memoryBudgetBytes / 1024 ** 3, 2)} GiB（{p.sessionInfo.resources.memoryBudgetBytes} B）</output>
        <output>线程来源 {p.sessionInfo.resources.threadSource} · 内存来源 {p.sessionInfo.resources.memorySource}</output>
        <output>设置来源 {p.sessionInfo.resources.settingsPath} · 修订 {p.sessionInfo.resources.settingsRevision}</output>
      </details>}
      {p.resourceError && <DismissibleNotice>{p.resourceError}</DismissibleNotice>}
      {p.running && !p.progress && <InputSettingsAction onClick={p.onStop}>停止</InputSettingsAction>}</>}
      progress={<>{p.progress && <MultiwfnProgress progress={p.progress} showFailureReason={!s.error} operationLabel="Hirshfeld" onStop={p.onStop}/ >}{p.running && !p.progress && <output role="status">Hirshfeld计算中…</output>}</>}>
      {s.error && (s.error.includes('cube-closure')
        ? <DismissibleNotice role="alert" className="postprocess-warning">权重0.5面到达当前计算边界。可切换开放接触面预览，或提供更完整的环境。<details className="analysis-method-details"><summary>计算诊断</summary><pre>{s.error}</pre></details></DismissibleNotice>
        : <MultiwfnErrorNotice message={s.error} identity={p.progress?.identity.runId}/>)}
      {result && !ranges.resultMatchesDraft && <p role="status" className="postprocess-note">参数已改变；当前显示上次计算结果。</p>}
      <AnalysisTaskSection title="表面" testId="hirshfeld-surface-card" onRestore={restorePlotting}>
        {!result ? <p className="postprocess-empty">计算后显示Hirshfeld权重0.5表面。</p> : <>
          <output>{result.mode === 'open-preview' ? '开放接触面 · 当前计算范围' : '完整闭合Hirshfeld表面'} · dnorm</output>
          <InputSettingsRow><InputSettingsCheckbox label="显示表面" checked={s.display.visible} onChange={visible => display({ visible })}/><InputSettingsCheckbox label="显示环境" checked={s.display.showEnvironment} onChange={showEnvironment => display({ showEnvironment })}/>
            <InputSettingsAction disabled={p.disabled} onClick={() => { void p.onExportImage?.(); }}>导出图像</InputSettingsAction>
            <ScientificPlotExportMenu disabled={p.disabled} options={[{ key: 'weight', label: '权重 Cube', run: () => p.onExportCube('shape') }, { key: 'dnorm', label: 'dnorm Cube', run: () => p.onExportCube('mapping') }]}/></InputSettingsRow>
          <SurfaceAppearanceControls label="表面外观" presets={['hirshfeld']} actions={<SaveSurfaceAppearanceDefault family="surface:hirshfeld" appearance={captureHirshfeldAppearance(s.display)}/>} value={s.display.appearancePreset} onChange={id => p.onChange({ display: hirshfeldAppearance(s.display, id) })}>
            <MeshFinishControls value={s.display.finish} onChange={finish => display({ finish })} labelPrefix="Hirshfeld表面"/>
          </SurfaceAppearanceControls>
          <InputSettingsRow><InputSettingsField label="不透明度"><input type="range" aria-label="Hirshfeld表面不透明度滑杆" {...matchingSliderRange(s.display.opacity,.05,1,.01)} value={s.display.opacity} onChange={event => display({ opacity: event.currentTarget.valueAsNumber })}/><NumericInput stepper adaptiveStep={0.1} aria-label="Hirshfeld表面不透明度" min={.05} max={1} step={.01} value={s.display.opacity} onChange={event => { const value = event.currentTarget.valueAsNumber; if (value >= .05 && value <= 1) display({ opacity: value }); }}/></InputSettingsField>
            <div className="analysis-control-group"><InputSettingsField label="色标最小值"><NumericInput  aria-label="Hirshfeld色标最小值" step={.1} value={s.display.range?.min ?? ''} placeholder="自动" onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value) && value < (s.display.range?.max ?? 1)) display({ range: { min: value, max: s.display.range?.max ?? 1 } }); }}/></InputSettingsField>
            <InputSettingsField label="最大值"><NumericInput  aria-label="Hirshfeld色标最大值" step={.1} value={s.display.range?.max ?? ''} placeholder="自动" onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value) && value > (s.display.range?.min ?? -.5)) display({ range: { min: s.display.range?.min ?? -.5, max: value } }); }}/></InputSettingsField></div>
            <InputSettingsAction onClick={() => display({ range: null })}>自动范围</InputSettingsAction>
            <InputSettingsCheckbox label="反转色标" checked={s.display.reverse} onChange={reverse => display({ reverse, appearancePreset: 'custom' })}/>
          </InputSettingsRow>
          <AnalysisColorbarLayoutControls layout={s.display.colorbarLayout} onChange={colorbarLayout => display({ colorbarLayout })} colorbar={p.colorbar} disabled={p.disabled}
            palette={{ colors: s.display.colors ?? ANALYSIS_PALETTES['blue-red'], reverse: s.display.reverse, zeroCentered: true, labelPrefix: 'Hirshfeld',
              onChange: colors => display({ colors, appearancePreset: 'custom' }) }}/>
        </>}
      </AnalysisTaskSection>
      <AnalysisTaskSection title="指纹图" testId="hirshfeld-fingerprint-card">
        {result?.fingerprint.sampleDiagnostic && <details className="analysis-method-details"><summary>原生样本诊断</summary><pre>{result.fingerprint.sampleDiagnostic}</pre></details>}
        {!result || !result.vertices.length ? <p className="postprocess-empty">{result ? '当前范围没有可可靠对应的原生指纹样本。' : '计算后显示总图和接触分项。'}</p> : <>
          <InputSettingsRow><InputSettingsField label="图内容"><select aria-label="Hirshfeld指纹图内容" value={focusKey} disabled={exporting} onChange={event => p.onChange({ selectedContact: options.find(focus => hirshfeldContactKey(focus.insideElement, focus.outsideElement, s.merged) === event.currentTarget.value) ?? null })}><option value="">总图</option>{options.map(focus => <option key={hirshfeldContactKey(focus.insideElement, focus.outsideElement, s.merged)} value={hirshfeldContactKey(focus.insideElement, focus.outsideElement, s.merged)}>{hirshfeldContactLabel(focus)}</option>)}</select></InputSettingsField>
            {p.onOpenFingerprint && <InputSettingsAction onClick={() => p.onOpenFingerprint?.({ result: { stamp: result.stamp, source: result.source, vertices: result.vertices, contacts: result.contacts }, focus: s.selectedContact, decimals: s.decimals, merged: s.merged, plotDisplay: s.plotDisplay })}>独立窗口</InputSettingsAction>}
            <ScientificPlotExportMenu disabled={exporting} options={[{ key: 'all', label: '总图＋全部分项 SVG', run: () => { void exportPlots('all'); } }, { key: 'combined', label: '总图＋选定分项组合 SVG', run: () => { void exportPlots('combined'); } }]}/></InputSettingsRow>
          <details className="analysis-method-details"><summary>组合图分项</summary><InputSettingsRow>{options.map(focus => { const key = hirshfeldContactKey(focus.insideElement, focus.outsideElement, s.merged); return <InputSettingsCheckbox key={key} label={hirshfeldContactLabel(focus)} checked={selectedExport.includes(key)} onChange={checked => setSelectedExport(previous => checked ? [...previous, key] : previous.filter(value => value !== key))}/>; })}</InputSettingsRow></details>
          {exporting && <output role="status">正在导出完整数据指纹图…</output>}{exportError && <DismissibleNotice>{exportError}</DismissibleNotice>}
          <HirshfeldFingerprint showDisplayControls={!exporting} exportEpoch={exportFocus} result={result} focus={exportFocus ? exportFocus.value : s.selectedContact} decimals={s.decimals} merged={s.merged} display={s.plotDisplay} onDisplay={plotDisplay => p.onChange({ plotDisplay })} exportHandle={receiveHandle} onContact={selectedContact => { if (!exporting) p.onChange({ selectedContact }); }}/>
        </>}
      </AnalysisTaskSection>
      <AnalysisTaskSection title="接触面积" testId="hirshfeld-area-card">
        {!result?.contacts ? <p className="postprocess-empty">{result ? '开放预览不提供完整表面面积与总面积占比。' : '完整闭合计算后显示原生接触面积。'}</p> : <>
          <InputSettingsRow><InputSettingsField label="显示方式"><select aria-label="接触面积显示方式" value={s.areaView} onChange={event => p.onChange({ areaView: event.currentTarget.value as typeof s.areaView })}><option value="table">表格</option><option value="chart">贡献图</option><option value="both">表格＋图</option></select></InputSettingsField><InputSettingsCheckbox label="双向合并" checked={s.merged} onChange={merged => p.onChange({ merged, selectedContact: null })}/>
            <ResultNumberFormatFields labelPrefix="接触面积" value={s.contactNumberFormat} fallbackDigits={s.decimals}
              onFallbackDigitsChange={decimals => p.onChange({ decimals })} onChange={contactNumberFormat => p.onChange({ contactNumberFormat })}/>
          </InputSettingsRow>
          <output>完整表面面积 {formatAnalysisValue(result.contacts.denominator.area, s.decimals, s.contactNumberFormat)} Å²</output>
          {s.areaView !== 'chart' && <ScientificDataTable hideTitle projection={table} selectionScope={`${result.stamp.requestId}:${s.merged}`} exportFileName="Ester-Studio-hirshfeld-contacts.txt" onExport={() => exportBlob(new Blob([scientificTableText(table)], { type: 'text/plain;charset=utf-8' }), 'Ester-Studio-hirshfeld-contacts.txt')}
            activeRowKey={focusKey} sorting={{ value: s.areaSort, direction: s.areaSortDirection, options: [{ value: 'contact', label: '接触类型' }, { value: 'area', label: '接触面积' }, { value: 'percent', label: '完整表面占比' }], onChange: (value, areaSortDirection) => p.onChange({ areaSort: value as typeof s.areaSort, areaSortDirection }) }}
            onRowActivate={row => { const contact = rows.find(value => hirshfeldContactKey(value.insideElement, value.outsideElement, s.merged) === row.key); if (contact) p.onChange({ selectedContact: { insideElement: contact.insideElement, outsideElement: contact.outsideElement, merged: s.merged } }); }}/ >}
          {s.areaView !== 'table' && <ResultsMcpInlinePlotSource kind="hirshfeld-contact-contribution" analysisId={p.mcpAnalysisId}><HirshfeldContactContribution appearanceKey={`hirshfeld-contact:${result.stamp.sourceId}:${result.stamp.sourceRevision}:${result.stamp.jobIndex}:${result.stamp.sourceFrameIndex}:${result.stamp.documentId}:${result.stamp.documentRevision}:${s.merged}`} rows={rows} merged={s.merged} decimals={s.decimals} numberFormat={s.contactNumberFormat} onContact={selectedContact => p.onChange({ selectedContact })}/></ResultsMcpInlinePlotSource>}
        </>}
      </AnalysisTaskSection>
    </AnalysisTaskLayout></InputSettingsLayout></section>;
}

export default function HirshfeldAnalysisControls(p: Parameters<typeof HirshfeldAnalysisControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['HirshfeldAnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><HirshfeldAnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:HirshfeldAnalysisControlsInner(p);
}
