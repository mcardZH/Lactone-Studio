import { useState } from "react";
import type { MonitorCardData } from "../../task-system/application-contracts";
import { ProjectUiScope, ProjectUiStore } from "../../projects/ui-state";
import ScientificPlot from "../results/ScientificPlot";
/** Display-only chart/table from already printed values; owns a private UI scope. */
export default function MonitorCard({ data, taskId }: { data: MonitorCardData; taskId: string }) {
	const [store] = useState(() => new ProjectUiStore()),
		[page, setPage] = useState(0);
	const pages = Math.max(1, Math.ceil(data.rows.length / 100)),
		current = Math.min(page, pages - 1);
	return (
		<ProjectUiScope store={store} scope={["task-monitor", taskId, data.kind]}>
			{data.plot && (
				<ScientificPlot
					title={data.title}
					xLabel={data.plot.xLabel}
					yLabel={data.plot.yLabel}
					series={data.plot.series}
					appearanceKey={`task:${taskId}:${data.kind}`}
					resetKey={`${taskId}:${data.kind}`}
					plotStyle="plain"
					height={260}
					exportFileName={`Ester-Studio-${data.kind}`}
				/>
			)}
			<div className="task-table-scroll">
				<table>
					<thead>
						<tr>
							{data.columns.map((column, index) => (
								<th key={index}>{column}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.rows.slice(current * 100, (current + 1) * 100).map((row, index) => (
							<tr key={current * 100 + index}>
								{row.map((value, i) => (
									<td key={i}>{value}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{pages > 1 && (
				<div className="task-actions">
					<button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
						上一页数据
					</button>
					<span>
						{current + 1} / {pages} · 共 {data.rows.length} 行
					</span>
					<button
						type="button"
						disabled={current === pages - 1}
						onClick={() => setPage(current + 1)}
					>
						下一页数据
					</button>
				</div>
			)}
			<small>{data.sourceLabel}</small>
		</ProjectUiScope>
	);
}
