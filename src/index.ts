#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
	pollDeviceToken,
	revokeDevice,
	sendHeartbeats,
	startDeviceFlow,
	toHeartbeats,
} from "./api";
import { type Config, load, save } from "./config";
import { isEmpty, parseTranscript } from "./transcript";

/**
 * The whole plugin, with no binary to install.
 *
 * Claude Code is a Node program, so Node is on the machine by definition.
 * Asking someone to download an unsigned executable — and then to argue with
 * their antivirus about it — in order to hand an API key to a plugin was the
 * wrong trade. Everything the plugin needs is a JSONL parser, two HTTP calls
 * and a token file.
 *
 * The CLI still exists and is still the right thing for editors that are not
 * Node programs. It is no longer a prerequisite for this one.
 */

const VERSION = "0.1.0";

function claudeProjectsDir(): string {
	const override = process.env.CLAUDE_CONFIG_DIR?.trim();
	return join(override || join(homedir(), ".claude"), "projects");
}

/**
 * Transcripts modified since the watermark.
 *
 * Filtering on mtime first means a long history costs one stat per file rather
 * than a full parse — this runs on every hook.
 *
 * `subagents` directories are skipped wholesale rather than filtered per line.
 * A subagent transcript carries its own cwd, so a single line missing the
 * `isSidechain` flag would double-count an entire session.
 */
function transcriptPaths(since: Date | null): string[] {
	const root = claudeProjectsDir();
	const out: string[] = [];

	const walk = (dir: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === "subagents") continue;
				walk(full);
				continue;
			}
			if (!e.name.endsWith(".jsonl")) continue;
			try {
				if (since && statSync(full).mtime <= since) continue;
			} catch {
				continue;
			}
			out.push(full);
		}
	};

	walk(root);
	return out;
}

/** The repository a session's working directory belongs to, if any. */
function gitRemote(cwd: string): string {
	if (!cwd) return "";
	try {
		return execFileSync("git", ["remote", "get-url", "origin"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim();
	} catch {
		return "";
	}
}

/**
 * Open a URL in the user's browser.
 *
 * Best effort: if it fails the link is already printed, so nothing is lost —
 * and a headless machine or an SSH session is a normal place to run this.
 */
function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "win32"
			? // `start` is a cmd builtin, not a program, and its first quoted
				// argument is taken as the window title — hence the empty one.
				["cmd", ["/c", "start", "", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		execFileSync(cmd, args, { stdio: "ignore", timeout: 5000 });
	} catch {
		// Printed above; the user can click it.
	}
}

async function activate(config: Config): Promise<number> {
	const init = await startDeviceFlow(
		config.apiUrl,
		hostname(),
		process.platform,
	);

	// Opened before anything is printed. The link already carries the code, so
	// in the normal case nobody has to read the code at all — and reading it
	// out of a scrolling tool-call log is exactly what made this feel slow.
	openBrowser(init.verification_uri_complete);

	console.log("");
	console.log("  Approve this machine in the browser tab that just opened.");
	console.log(`  If it did not open: ${init.verification_uri_complete}`);
	console.log("");
	console.log(`  The code, if it asks: ${init.user_code}`);

	const deadline = Date.now() + init.expires_in * 1000;
	// The server's `interval` is a floor, not a schedule. Waiting a full five
	// seconds before even the first check makes an approval that already
	// happened feel like a hang; a short first poll costs one request.
	const wait = Math.max(1, init.interval) * 1000;
	let delay = 800;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, delay));
		delay = wait;
		const result = await pollDeviceToken(config.apiUrl, init.device_code);
		if (result.status === "ok") {
			save({ ...config, deviceToken: result.token });
			console.log("  Activated. Nothing else to set up.");
			return 0;
		}
		if (result.status === "denied") {
			console.error(`  Activation failed: ${result.error}`);
			return 1;
		}
	}
	console.error("  That code expired. Run activation again.");
	return 1;
}

/**
 * Is this actually working?
 *
 * The question a plugin user has, and the one that took an hour to answer by
 * hand when a stale cache left an old build running against a newer
 * marketplace. Every line here is something that was guessed at during that:
 * which build is running, whether there is a token, when a sync last happened,
 * and how many transcripts are in scope.
 */
async function status(config: Config): Promise<number> {
	const paths = transcriptPaths(null);
	const since = config.lastParsedAt ? new Date(config.lastParsedAt) : null;
	const pending = transcriptPaths(since).length;

	console.log("");
	console.log(`  Plugin      ${VERSION}`);
	console.log(`  Machine     ${hostname()}`);
	console.log(`  Account     ${config.deviceToken ? "connected" : "not connected — run /inlinr:activate"}`);
	console.log(`  Server      ${config.apiUrl}`);
	console.log(
		`  Last sync   ${config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleString() : "never"}`,
	);
	console.log(
		`  Transcripts ${paths.length} found, ${pending} with something new`,
	);

	if (config.deviceToken && paths.length === 0) {
		console.log("");
		console.log(
			"  No transcripts found. Claude Code writes them under ~/.claude/projects,",
		);
		console.log(
			"  so this is expected on a machine where you have not used it yet.",
		);
	}
	console.log("");
	return 0;
}

async function deactivate(config: Config): Promise<number> {
	if (!config.deviceToken) {
		console.log("  This machine is not connected.");
		return 0;
	}
	const revoked = await revokeDevice(config.apiUrl, config.deviceToken);
	// The local token goes either way. A failed revoke leaves a stale entry in
	// the dashboard, which is annoying; keeping a working token on a machine
	// somebody asked to disconnect is worse.
	save({ ...config, deviceToken: "", lastParsedAt: null, lastSyncAt: null });
	console.log(
		revoked
			? "  Disconnected. The device has been revoked on inlinr.com too."
			: "  Disconnected locally. inlinr.com could not be reached, so remove the device from Settings when you can.",
	);
	return 0;
}

async function sync(config: Config, throttleSeconds: number): Promise<number> {
	if (!config.deviceToken) {
		// Silent on purpose. A hook firing on every tool call must not print an
		// error into somebody's session because they have not activated yet.
		return 0;
	}

	if (throttleSeconds > 0 && config.lastSyncAt) {
		const age = Date.now() - Date.parse(config.lastSyncAt);
		if (Number.isFinite(age) && age < throttleSeconds * 1000) return 0;
	}

	const since = config.lastParsedAt ? new Date(config.lastParsedAt) : null;
	const paths = transcriptPaths(since);
	if (paths.length === 0) {
		save({ ...config, lastSyncAt: new Date().toISOString() });
		return 0;
	}

	let newest = since;
	const beats = [];
	const remotes = new Map<string, string>();

	for (const path of paths) {
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const session = parseTranscript(content, since);
		if (!session || isEmpty(session)) continue;

		let remote = remotes.get(session.cwd);
		if (remote === undefined) {
			remote = gitRemote(session.cwd);
			remotes.set(session.cwd, remote);
		}
		// Without a remote there is nothing to attribute the work to — most
		// often a conversation started in a scratch folder.
		if (!remote) continue;

		beats.push(...toHeartbeats(session, remote, VERSION));
		if (session.lastSeen) {
			const t = new Date(session.lastSeen);
			if (!newest || t > newest) newest = t;
		}
	}

	if (beats.length > 0) {
		await sendHeartbeats(config.apiUrl, config.deviceToken, beats);
	}

	save({
		...config,
		lastParsedAt: newest ? newest.toISOString() : config.lastParsedAt,
		lastSyncAt: new Date().toISOString(),
	});
	return 0;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const config = load();

	if (args[0] === "activate") return activate(config);
	if (args[0] === "deactivate") return deactivate(config);
	if (args[0] === "status") return status(config);
	if (args[0] === "--version") {
		console.log(VERSION);
		return 0;
	}

	const i = args.indexOf("--throttle");
	const throttle = i >= 0 ? Number(args[i + 1] ?? 0) : 0;
	return sync(config, Number.isFinite(throttle) ? throttle : 0);
}

// A tracker must never break the turn it is measuring. Every path returns 0
// unless it is the interactive activation command, where an exit code is the
// only way to report failure.
main()
	.then((code) => process.exit(code))
	.catch((err) => {
		if (process.argv[2] === "activate") {
			console.error(`  ${(err as Error).message}`);
			process.exit(1);
		}
		process.exit(0);
	});
