import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./presentation";
export interface TaskScopedError {
	error: string;
	identity: string;
	epoch: number;
}
export type TaskErrorReporter = (error: unknown) => void;
/** Owned by a window/task/run/source presentation bucket, never global. */
export interface TaskErrorDismissalState {
	automaticCauses: Set<string>;
}
let nextScopeId = 0;
function errorCause(error: unknown): string {
	const message = errorMessage(error).split(/\r?\n/, 1)[0].trim();
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	return JSON.stringify([code, message]);
}
/** One mounted task UI owner, never global. Closed causes remain closed within their attempt. */
export class TaskErrorScope {
	private readonly id = ++nextScopeId;
	private sequence = 0;
	private active = true;
	private dismissed = new Set<string>();
	private dismissedAutomaticCauses = new Set<string>();
	private causes = new Map<string, string>();
	private current: TaskScopedError | null = null;
	epoch = 0;
	constructor(
		private owner: string,
		private publish: (error: TaskScopedError | null) => void,
		private retained?: TaskErrorDismissalState
	) {}
	setOwner(owner: string) {
		if (owner === this.owner) return;
		this.owner = owner;
		this.epoch++;
		this.dismissed.clear();
		this.dismissedAutomaticCauses.clear();
		this.causes.clear();
		this.current = null;
	}
	setDismissalState(retained?: TaskErrorDismissalState) {
		this.retained = retained;
	}
	activate() {
		this.active = true;
	}
	deactivate() {
		this.active = false;
		this.epoch++;
		this.current = null;
		this.dismissed.clear();
		this.dismissedAutomaticCauses.clear();
		this.causes.clear();
	}
	clear = () => {
		this.current = null;
		this.publish(null);
	};
	dismiss = (identity: string) => {
		this.dismissed.add(identity);
		const cause = this.causes.get(identity);
		if (cause) this.dismissedAutomaticCauses.add(cause);
		if (cause) this.retained?.automaticCauses.add(cause);
		if (this.current?.identity === identity) this.clear();
	};
	private reporter(channel: string, automatic = false): TaskErrorReporter {
		const epoch = this.epoch,
			owner = this.owner;
		return (error) => {
			if (!this.active || this.epoch !== epoch || this.owner !== owner) return;
			const cause = errorCause(error),
				identity = JSON.stringify([this.id, owner, epoch, channel, cause]);
			if (
				this.dismissed.has(identity) ||
				(automatic &&
					(this.dismissedAutomaticCauses.has(cause) || this.retained?.automaticCauses.has(cause)))
			)
				return;
			this.causes.set(identity, cause);
			this.current = { error: errorMessage(error), identity, epoch };
			this.publish(this.current);
		};
	}
	automatic = (channel: string): TaskErrorReporter => this.reporter(`automatic:${channel}`, true);
	attempt = (action: string): TaskErrorReporter => {
		this.clear();
		return this.reporter(`attempt:${++this.sequence}:${action}`);
	};
}
export function useTaskErrorScope(owner: string, retained?: TaskErrorDismissalState) {
	const [notice, setNotice] = useState<TaskScopedError | null>(null),
		scope = useRef<TaskErrorScope | null>(null);
	if (!scope.current)
		scope.current = new TaskErrorScope(
			owner,
			(value) =>
				setNotice((current) =>
					current?.identity === value?.identity && current?.error === value?.error ? current : value
				),
			retained
		);
	const current = scope.current;
	current.setDismissalState(retained);
	current.setOwner(owner);
	useEffect(() => {
		current.activate();
		return () => current.deactivate();
	}, [current]);
	const visible = notice?.epoch === current.epoch ? notice : null;
	return {
		notice: visible,
		attempt: current.attempt,
		automatic: current.automatic,
		clear: current.clear,
		dismiss: () => {
			if (visible) current.dismiss(visible.identity);
		}
	};
}
