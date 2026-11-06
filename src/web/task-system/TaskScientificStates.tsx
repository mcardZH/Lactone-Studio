import type { TaskScientificStateView } from "../../task-system/application-contracts";
const stateLabels: Record<TaskScientificStateView["state"], string> = {
	unknown: "未知",
	"in-progress": "进行中",
	satisfied: "已满足",
	"not-satisfied": "未满足",
	"not-applicable": "不适用",
	conflict: "信息冲突"
};
/** Display source-bound dimensions exactly as supplied; process exit never supplies missing science. */
export default function TaskScientificStates({
	rows
}: {
	rows?: readonly TaskScientificStateView[];
}) {
	if (!rows?.length) return null;
	return (
		<section className="task-scientific-states" aria-label="科学状态">
			<h4>科学状态</h4>
			<dl>
				{rows.map((row) => (
					<div
						key={`${row.jobIndex}:${row.segmentIndex}:${row.stageId ?? ""}:${row.frameIndex ?? ""}:${row.sourceLine ?? ""}:${row.key}`}
						data-scientific-key={row.key}
						data-scientific-state={row.state}
					>
						<dt>{row.label}</dt>
						<dd>
							<span>{stateLabels[row.state] ?? row.state}</span>
							<details>
								<summary>来源与说明</summary>
								{row.sourceLabel && <p>{row.sourceLabel}</p>}
								<dl>
									<dt>作业索引</dt>
									<dd>{row.jobIndex}</dd>
									<dt>段索引</dt>
									<dd>{row.segmentIndex}</dd>
									{row.stageId && (
										<>
											<dt>阶段</dt>
											<dd>{row.stageId}</dd>
										</>
									)}
									{row.frameIndex != null && (
										<>
											<dt>帧索引</dt>
											<dd>{row.frameIndex}</dd>
										</>
									)}
									{row.sourceLine != null && (
										<>
											<dt>来源行</dt>
											<dd>{row.sourceLine}</dd>
										</>
									)}
								</dl>
								{row.raw && (
									<>
										<p>原文</p>
										<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
											{row.raw}
										</pre>
									</>
								)}
								{row.reason && <p>{row.reason}</p>}
								{row.evidenceRefs.length > 0 && (
									<>
										<p>证据引用</p>
										<ul>
											{row.evidenceRefs.map((reference, index) => (
												<li key={index}>
													<code>{reference}</code>
												</li>
											))}
										</ul>
									</>
								)}
							</details>
						</dd>
					</div>
				))}
			</dl>
		</section>
	);
}
