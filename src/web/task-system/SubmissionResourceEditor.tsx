import { useEffect, useRef, useState } from "react";
import {
	convertSubmissionMemory,
	patchSubmissionResource,
	readSubmissionResourceEditor
} from "./submission-resources";
import { DismissibleNotice } from "../DismissibleNotice";
import TaskFieldHelp from "./TaskFieldHelp";
export default function SubmissionResourceEditor({
	engine,
	text,
	disabled,
	onChange,
	onInvalid
}: {
	engine: "gaussian" | "orca";
	text: string;
	disabled: boolean;
	onChange(text: string): void;
	onInvalid(invalid: boolean): void;
}) {
	const resources = readSubmissionResourceEditor(engine, text);
	const [cpu, setCpu] = useState(resources.cpu),
		[memory, setMemory] = useState(resources.memory),
		[unit, setUnit] = useState(resources.unit),
		[errors, setErrors] = useState({ cpu: "", memory: "" }),
		[dirty, setDirty] = useState({ cpu: false, memory: false });
	const ownText = useRef<string | null>(null);
	useEffect(() => {
		if (text === ownText.current) {
			ownText.current = null;
			return;
		}
		const value = readSubmissionResourceEditor(engine, text);
		setCpu(value.cpu);
		setMemory(value.memory);
		setUnit(value.unit);
		setErrors({ cpu: "", memory: "" });
		setDirty({ cpu: false, memory: false });
	}, [engine, text]);
	useEffect(
		() => onInvalid(dirty.cpu || dirty.memory || resources.problems.length > 0),
		[dirty.cpu, dirty.memory, resources.problems.length]
	);
	function apply(field: "cpu" | "memory", value: string, nextUnit = unit) {
		try {
			const next = patchSubmissionResource(engine, text, field, value, nextUnit);
			setErrors((current) => ({ ...current, [field]: "" }));
			setDirty((current) => ({ ...current, [field]: false }));
			ownText.current = next;
			onChange(next);
		} catch (e) {
			setErrors((current) => ({ ...current, [field]: (e as Error).message }));
			setDirty((current) => ({ ...current, [field]: true }));
		}
	}
	return (
		<div className="task-resource-editor">
			<label>
				{engine === "gaussian" ? "共享线程数" : "MPI进程数"}
				<input
					aria-label="提交核数或进程数"
					inputMode="numeric"
					value={cpu}
					disabled={disabled || resources.problems.length > 0}
					aria-invalid={Boolean(errors.cpu) || undefined}
					onChange={(e) => {
						setCpu(e.target.value);
						setDirty((current) => ({ ...current, cpu: true }));
					}}
					onBlur={() => {
						if (dirty.cpu) apply("cpu", cpu);
					}}
				/>
			</label>
			<label>
				<span className="task-field-heading">
					{engine === "gaussian" ? "总内存" : "每进程内存"}
					<TaskFieldHelp
						topic={engine === "gaussian" ? "gaussianMemory" : "orcaMemory"}
						label="内存说明"
					/>
				</span>
				<span className="task-resource-memory">
					<input
						aria-label="提交内存"
						inputMode="decimal"
						value={memory}
						disabled={disabled || resources.problems.length > 0}
						aria-invalid={Boolean(errors.memory) || undefined}
						onChange={(e) => {
							setMemory(e.target.value);
							setDirty((current) => ({ ...current, memory: true }));
						}}
						onBlur={() => {
							if (dirty.memory) apply("memory", memory);
						}}
					/>
					{engine === "orca" ? (
						<span>MB</span>
					) : (
						<select
							aria-label="提交内存单位"
							disabled={disabled || resources.problems.length > 0}
							value={unit}
							onChange={(e) => {
								if (!memory) {
									setUnit(e.target.value);
									return;
								}
								try {
									const converted = convertSubmissionMemory(memory, unit, e.target.value);
									setUnit(e.target.value);
									setMemory(converted);
									apply("memory", converted, e.target.value);
								} catch (error) {
									setErrors((current) => ({ ...current, memory: (error as Error).message }));
									setDirty((current) => ({ ...current, memory: true }));
								}
							}}
						>
							{["MB", "GB"].map((value) => (
								<option key={value}>{value}</option>
							))}
						</select>
					)}
				</span>
			</label>
			{[...resources.problems, ...Object.values(errors).filter(Boolean)].map((message, index) => (
				<DismissibleNotice key={index} identity={`${engine}:${text}:${message}`}>
					{message}
				</DismissibleNotice>
			))}
		</div>
	);
}
