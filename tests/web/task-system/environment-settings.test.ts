import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentView, TaskSystemBridge } from "../../../src/task-system/application-contracts";
import {
	availableEnvironmentPresets,
	detectClientPlatform,
	environmentPathPlaceholder,
	isMacClientPlatform
} from "../../../src/web/task-system/environment-assistant";
import EnvironmentSettings, {
	environmentDraftForMode,
	isValidEnvironmentPath,
	newEnvironment
} from "../../../src/web/task-system/EnvironmentSettings";

function createStubBridge(): TaskSystemBridge {
	return {
		request: vi.fn(async () => ({ siteProfiles: [] })) as unknown as TaskSystemBridge["request"],
		subscribe: vi.fn(() => () => {})
	};
}

function extractEnvironmentTypeOptions(html: string): string[] {
	const selectMatch = html.match(/<select[^>]*aria-label="环境类型"[^>]*>([\s\S]*?)<\/select>/);
	if (!selectMatch) return [];
	return [...selectMatch[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)].map((m) => m[1]);
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

	it("newEnvironment and environmentDraftForMode default to ssh on macOS and local on Windows", () => {
		const macEnv = newEnvironment("darwin");
		expect(macEnv.connectionKind).toBe("ssh");
		expect(macEnv.schedulerKind).toBe("none");
		expect(macEnv.displayName).toBe("Gaussian · SSH服务器");

		const winEnv = newEnvironment("win32");
		expect(winEnv.connectionKind).toBe("local");
		expect(winEnv.schedulerKind).toBe("none");
		expect(winEnv.displayName).toBe("Gaussian · Windows 本机");

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

	it("EnvironmentSettings renders only ssh and slurm options on macOS even when loaded with legacy local/wsl draft", () => {
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
			expect(extractEnvironmentTypeOptions(newHtml)).toEqual(["ssh", "slurm"]);

			// 2. Legacy local and wsl drafts on macOS: select still only renders ["ssh", "slurm"]
			const legacyLocal: EnvironmentView = {
				...newEnvironment("win32"),
				environmentId: "legacy-local-1",
				revision: 1,
				connectionKind: "local",
				executable: "C:\\G16W\\g16.exe",
				workingRoot: "D:\\ES-Tasks"
			};
			const legacyLocalHtml = renderToStaticMarkup(
				createElement(EnvironmentSettings, {
					bridge: createStubBridge(),
					environments: [legacyLocal],
					canManage: true,
					onChanged: () => {},
					onClose: () => {}
				})
			);
			expect(extractEnvironmentTypeOptions(legacyLocalHtml)).toEqual(["ssh", "slurm"]);
			expect(legacyLocalHtml).toContain("在 macOS 上不受支持");

			const legacyWsl: EnvironmentView = {
				...newEnvironment("win32"),
				environmentId: "legacy-wsl-1",
				revision: 1,
				connectionKind: "wsl",
				distribution: "Ubuntu-22.04",
				user: "alice",
				executable: "/opt/orca/orca",
				workingRoot: "/home/alice/es-tasks"
			};
			const legacyWslHtml = renderToStaticMarkup(
				createElement(EnvironmentSettings, {
					bridge: createStubBridge(),
					environments: [legacyWsl],
					canManage: true,
					onChanged: () => {},
					onClose: () => {}
				})
			);
			expect(extractEnvironmentTypeOptions(legacyWslHtml)).toEqual(["ssh", "slurm"]);
			expect(legacyWslHtml).toContain("在 macOS 上不受支持");

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
			expect(extractEnvironmentTypeOptions(winHtml)).toEqual(["local", "wsl", "ssh", "slurm"]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
