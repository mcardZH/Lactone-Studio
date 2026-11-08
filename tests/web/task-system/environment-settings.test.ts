import React, { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
	EnvironmentView,
	TaskSystemBridge
} from "../../../src/task-system/application-contracts";
import {
	availableEnvironmentPresets,
	detectClientPlatform,
	environmentPathPlaceholder,
	isMacClientPlatform
} from "../../../src/web/task-system/environment-assistant";
import EnvironmentSettings, {
	environmentDraftForMode,
	isDefaultEnvironmentDisplayName,
	isValidEnvironmentPath,
	newEnvironment,
	type EnvironmentSettingsProps
} from "../../../src/web/task-system/EnvironmentSettings";

function createStubBridge(): TaskSystemBridge {
	return {
		request: vi.fn(async () => ({ siteProfiles: [] })) as unknown as TaskSystemBridge["request"],
		subscribe: vi.fn(() => () => {})
	};
}

function extractVisibleEnvironmentTypeOptions(html: string): string[] {
	const selectMatch = html.match(/<select[^>]*aria-label="环境类型"[^>]*>([\s\S]*?)<\/select>/);
	if (!selectMatch) return [];
	return [...selectMatch[1].matchAll(/<option([^>]*)>/g)]
		.filter((m) => !/\bhidden\b/.test(m[1]))
		.map((m) => m[1].match(/value="([^"]*)"/)?.[1] ?? "");
}

function findElement(
	node: ReactNode,
	predicate: (el: React.ReactElement<Record<string, unknown>>) => boolean
): React.ReactElement<Record<string, unknown>> | null {
	if (!node) return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findElement(child, predicate);
			if (found) return found;
		}
		return null;
	}
	if (!isValidElement(node)) return null;
	const el = node as React.ReactElement<Record<string, unknown>>;
	if (predicate(el)) return el;
	return findElement(el.props.children as ReactNode, predicate);
}

function createInteractiveEnvironmentHarness(props: EnvironmentSettingsProps) {
	const states: unknown[] = [];
	const refs: { current: unknown }[] = [];
	const internals = (
		React as unknown as {
			__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
		}
	).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

	function render() {
		let stateIdx = 0;
		let refIdx = 0;
		let idIdx = 0;
		const prevDispatcher = internals.H;
		internals.H = {
			useState(initial: unknown) {
				const idx = stateIdx++;
				if (idx >= states.length) {
					states[idx] = typeof initial === "function" ? (initial as () => unknown)() : initial;
				}
				const setState = (next: unknown) => {
					states[idx] =
						typeof next === "function"
							? (next as (prev: unknown) => unknown)(states[idx])
							: next;
				};
				return [states[idx], setState];
			},
			useRef(initial: unknown) {
				const idx = refIdx++;
				if (idx >= refs.length) {
					refs[idx] = { current: initial };
				}
				return refs[idx];
			},
			useEffect() {},
			useCallback(fn: unknown) {
				return fn;
			},
			useMemo(fn: () => unknown) {
				return fn();
			},
			useId() {
				return `test-id-${idIdx++}`;
			}
		};
		try {
			return EnvironmentSettings(props);
		} finally {
			internals.H = prevDispatcher;
		}
	}

	return { render };
}

describe("task-system macOS and Windows environment settings helpers", () => {
	it("detectClientPlatform and isMacClientPlatform identify darwin, win32, and linux", () => {
		expect(detectClientPlatform("darwin")).toBe("darwin");
		expect(detectClientPlatform("MacIntel")).toBe("darwin");
		expect(detectClientPlatform("win32")).toBe("win32");
		expect(detectClientPlatform("Win32")).toBe("win32");
		expect(detectClientPlatform("linux")).toBe("linux");

		expect(isMacClientPlatform("darwin")).toBe(true);
		expect(isMacClientPlatform("MacIntel")).toBe(true);
		expect(isMacClientPlatform("win32")).toBe(false);
		expect(isMacClientPlatform("linux")).toBe(false);
	});

	it("availableEnvironmentPresets hides local and wsl on macOS and preserves all 4 presets on Windows", () => {
		const macPresets = availableEnvironmentPresets("darwin");
		expect(macPresets.map((p) => p.id)).toEqual(["ssh", "slurm"]);

		const winPresets = availableEnvironmentPresets("win32");
		expect(winPresets.map((p) => p.id)).toEqual(["windows", "wsl", "ssh", "slurm"]);
	});

	it("environmentPathPlaceholder returns POSIX privateKeyPath example on macOS/Linux and Windows example on win32", () => {
		const sshGaussian = { engineId: "gaussian" as const, connectionKind: "ssh" as const };
		expect(environmentPathPlaceholder(sshGaussian, "privateKeyPath", "darwin")).toBe(
			"例如 /Users/your-user/.ssh/id_ed25519"
		);
		expect(environmentPathPlaceholder(sshGaussian, "privateKeyPath", "linux")).toBe(
			"例如 /home/your-user/.ssh/id_ed25519"
		);
		expect(environmentPathPlaceholder(sshGaussian, "privateKeyPath", "win32")).toBe(
			"例如 C:\\Users\\your-user\\.ssh\\id_ed25519"
		);
		expect(environmentPathPlaceholder(sshGaussian, "workingRoot", "darwin")).toBe(
			"例如 /home/your-user/es-tasks"
		);
	});

	it("newEnvironment, isDefaultEnvironmentDisplayName, and environmentDraftForMode default to ssh on macOS and local on Windows", () => {
		const macEnv = newEnvironment("darwin");
		expect(macEnv.connectionKind).toBe("ssh");
		expect(macEnv.schedulerKind).toBe("none");
		expect(macEnv.displayName).toBe("Gaussian · SSH服务器");
		expect(isDefaultEnvironmentDisplayName(macEnv.displayName)).toBe(true);

		const winEnv = newEnvironment("win32");
		expect(winEnv.connectionKind).toBe("local");
		expect(winEnv.schedulerKind).toBe("none");
		expect(winEnv.displayName).toBe("Gaussian · Windows 本机");
		expect(isDefaultEnvironmentDisplayName(winEnv.displayName)).toBe(true);
		expect(isDefaultEnvironmentDisplayName("My Custom Cluster")).toBe(false);

		const slurmDraft = environmentDraftForMode(macEnv, "slurm", "orca", undefined, false, "darwin");
		expect(slurmDraft.connectionKind).toBe("ssh");
		expect(slurmDraft.schedulerKind).toBe("slurm");
		expect(slurmDraft.engineId).toBe("orca");
		expect(slurmDraft.displayName).toBe("ORCA · SSH + Slurm");
	});

	it("isValidEnvironmentPath validates POSIX privateKeyPath on darwin/linux and Windows privateKeyPath on win32", () => {
		// macOS client privateKeyPath
		expect(
			isValidEnvironmentPath("privateKeyPath", "/Users/alice/.ssh/id_ed25519", "ssh", "darwin")
		).toBe(true);
		expect(
			isValidEnvironmentPath(
				"privateKeyPath",
				"C:\\Users\\alice\\.ssh\\id_ed25519",
				"ssh",
				"darwin"
			)
		).toBe(false);
		expect(isValidEnvironmentPath("privateKeyPath", "id_ed25519", "ssh", "darwin")).toBe(false);

		// Linux client privateKeyPath (aligned with backend non-win32 POSIX rule)
		expect(
			isValidEnvironmentPath("privateKeyPath", "/home/alice/.ssh/id_ed25519", "ssh", "linux")
		).toBe(true);
		expect(
			isValidEnvironmentPath(
				"privateKeyPath",
				"C:\\Users\\alice\\.ssh\\id_ed25519",
				"ssh",
				"linux"
			)
		).toBe(false);

		// Windows client privateKeyPath
		expect(
			isValidEnvironmentPath("privateKeyPath", "C:\\Users\\alice\\.ssh\\id_ed25519", "ssh", "win32")
		).toBe(true);
		expect(
			isValidEnvironmentPath("privateKeyPath", "/Users/alice/.ssh/id_ed25519", "ssh", "win32")
		).toBe(false);

		// Remote SSH executable / workingRoot are always POSIX
		expect(isValidEnvironmentPath("executable", "/opt/orca/orca", "ssh", "darwin")).toBe(true);
		expect(isValidEnvironmentPath("executable", "/opt/orca/orca", "ssh", "win32")).toBe(true);
		expect(isValidEnvironmentPath("workingRoot", "D:\\ES-Tasks", "ssh", "darwin")).toBe(false);
	});

	it("EnvironmentSettings on macOS renders only ssh/slurm visible options and supports switching legacy local/wsl drafts directly to ssh", () => {
		vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
		try {
			// 1. New draft on macOS
			const newHtml = renderToStaticMarkup(
				createElement(EnvironmentSettings, {
					bridge: createStubBridge(),
					environments: [],
					canManage: true,
					onChanged: () => {},
					onClose: () => {}
				})
			);
			expect(extractVisibleEnvironmentTypeOptions(newHtml)).toEqual(["ssh", "slurm"]);
			expect(newHtml).toContain('<option value="ssh" selected="">SSH服务器</option>');

			// 2. Interactive test: legacy local and wsl drafts on macOS can both switch directly to "ssh"
			const legacyLocal: EnvironmentView = {
				...newEnvironment("win32"),
				environmentId: "",
				revision: 0,
				connectionKind: "local",
				executable: "C:\\G16W\\g16.exe",
				workingRoot: "D:\\ES-Tasks"
			};
			const legacyWsl: EnvironmentView = {
				...newEnvironment("win32"),
				environmentId: "",
				revision: 0,
				displayName: "Gaussian · WSL2",
				connectionKind: "wsl",
				distribution: "Ubuntu-22.04",
				user: "alice",
				executable: "/opt/orca/orca",
				workingRoot: "/home/alice/es-tasks"
			};

			for (const legacyDraft of [legacyLocal, legacyWsl]) {
				const staticBefore = renderToStaticMarkup(
					createElement(EnvironmentSettings, {
						bridge: createStubBridge(),
						environments: [legacyDraft],
						canManage: true,
						onChanged: () => {},
						onClose: () => {}
					})
				);
				expect(extractVisibleEnvironmentTypeOptions(staticBefore)).toEqual(["ssh", "slurm"]);
				// Before switching, the hidden placeholder is selected so "ssh" is not falsely marked selected
				expect(staticBefore).toContain(
					'<option value="" disabled="" hidden="" selected="">请选择远程环境</option>'
				);
				expect(staticBefore).not.toContain('<option value="ssh" selected="">');
				expect(staticBefore).toContain("在 macOS 上不受支持");

				// Interactive state transition: select "ssh" directly on the <select aria-label="环境类型">
				const harness = createInteractiveEnvironmentHarness({
					bridge: createStubBridge(),
					environments: [legacyDraft],
					canManage: true,
					onChanged: () => {},
					onClose: () => {}
				});
				const treeBefore = harness.render();
				const selectBefore = findElement(
					treeBefore,
					(el) => el.type === "select" && el.props["aria-label"] === "环境类型"
				);
				expect(selectBefore?.props.value).toBe("");
				// Directly invoke onChange with "ssh"
				const onChange = selectBefore?.props.onChange as (event: {
					target: { value: string };
				}) => void;
				onChange({ target: { value: "ssh" } });

				const treeAfter = harness.render();
				const selectAfter = findElement(
					treeAfter,
					(el) => el.type === "select" && el.props["aria-label"] === "环境类型"
				);
				expect(selectAfter?.props.value).toBe("ssh");

				const nameInputAfter = findElement(
					treeAfter,
					(el) => el.type === "input" && el.props["aria-label"] === "环境名称"
				);
				expect(nameInputAfter?.props.value).toBe("Gaussian · SSH服务器");

				const hostInputAfter = findElement(
					treeAfter,
					(el) => el.type === "input" && el.props["aria-label"] === "主机"
				);
				expect(hostInputAfter).not.toBeNull();
			}

			// 3. Windows client renders all 4 options
			vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows NT 10.0" });
			const winHtml = renderToStaticMarkup(
				createElement(EnvironmentSettings, {
					bridge: createStubBridge(),
					environments: [],
					canManage: true,
					onChanged: () => {},
					onClose: () => {}
				})
			);
			expect(extractVisibleEnvironmentTypeOptions(winHtml)).toEqual([
				"local",
				"wsl",
				"ssh",
				"slurm"
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
