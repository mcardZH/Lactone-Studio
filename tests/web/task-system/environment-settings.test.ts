import { describe, expect, it } from "vitest";
import {
	availableEnvironmentPresets,
	detectClientPlatform,
	environmentPathPlaceholder,
	isMacClientPlatform
} from "../../../src/web/task-system/environment-assistant";
import {
	environmentDraftForMode,
	isValidEnvironmentPath,
	newEnvironment
} from "../../../src/web/task-system/EnvironmentSettings";

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
	});

	it("availableEnvironmentPresets hides local and wsl on macOS and preserves all 4 presets on Windows", () => {
		const macPresets = availableEnvironmentPresets("darwin");
		expect(macPresets.map((p) => p.id)).toEqual(["ssh", "slurm"]);

		const winPresets = availableEnvironmentPresets("win32");
		expect(winPresets.map((p) => p.id)).toEqual(["windows", "wsl", "ssh", "slurm"]);
	});

	it("environmentPathPlaceholder returns POSIX privateKeyPath example on macOS and Windows example on win32", () => {
		const sshGaussian = { engineId: "gaussian" as const, connectionKind: "ssh" as const };
		expect(environmentPathPlaceholder(sshGaussian, "privateKeyPath", "darwin")).toBe(
			"例如 /Users/your-user/.ssh/id_ed25519"
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

	it("isValidEnvironmentPath validates POSIX privateKeyPath on macOS and Windows privateKeyPath on win32", () => {
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
});
