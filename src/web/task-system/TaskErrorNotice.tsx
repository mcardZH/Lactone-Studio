import { useState } from "react";
import type { TaskSystemBridge } from "../../task-system/application-contracts";
import { DismissibleNotice } from "../DismissibleNotice";
export function presentTaskError(error: string): { message: string; details: string | null } {
	const first = error.split(/\r?\n/, 1)[0].trim().replace(
		/^Error invoking remote method 'sciyue:[a-z0-9-]+': (?:Error: )?/i,
		""
	);
	const concise = first.length > 0 && first.length <= 140 && /[\u3400-\u9fff]/u.test(first);
	const message = concise ? first : "本次操作未完成";
	return { message, details: message === error.trim() ? null : error };
}
/** A native diagnostic stays available under details, outside the task's short reason. */
export default function TaskErrorNotice({
	error,
	identity,
	bridge,
	onDismiss
}: {
	error: string;
	identity?: unknown;
	bridge?: TaskSystemBridge;
	onDismiss?(): void;
}) {
	const value = presentTaskError(error),
		currentIdentity = identity ?? error,
		[copyError, setCopyError] = useState<{ identity: unknown; failed: boolean } | null>(null);
	return (
		<DismissibleNotice identity={currentIdentity} onDismiss={onDismiss}>
			{value.message}
			{value.details && (
				<details>
					<summary>详情</summary>
					<pre>{value.details}</pre>
					{bridge && (
						<button
							type="button"
							onClick={() =>
								void bridge.request("clipboard.write", { text: value.details! }).then(
									() => setCopyError({ identity: currentIdentity, failed: false }),
									() => setCopyError({ identity: currentIdentity, failed: true })
								)
							}
						>
							复制详情
						</button>
					)}
					{copyError?.identity === currentIdentity && copyError.failed && (
						<span role="status">复制未完成，可手动选择详情文本</span>
					)}
				</details>
			)}
		</DismissibleNotice>
	);
}
