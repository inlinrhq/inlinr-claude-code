import type { Session } from "./transcript";

/**
 * The two things this plugin needs from the server: a device token, and
 * somewhere to put heartbeats.
 *
 * Both endpoints are the ones the CLI already uses, deliberately. A second
 * ingest path would be a second place for the wire contract to drift, and the
 * contract is shared across three repositories as it is.
 */

export type DeviceInit = {
	device_code: string;
	user_code: string;
	verification_uri_complete: string;
	interval: number;
	expires_in: number;
};

/**
 * `client_name` is the machine, not the plugin.
 *
 * The dashboard titles each connected device with `clientName` and puts the
 * editor underneath, so every other device reads "DESKTOP-FTIR921 / VS Code".
 * Sending the plugin's own name here made this one read "claude-code-inlinr"
 * with nothing to say which machine it was — which is the one thing the title
 * is for when you have three of them.
 */
export async function startDeviceFlow(
	apiUrl: string,
	hostname: string,
	platform: string,
): Promise<DeviceInit> {
	const res = await fetch(`${apiUrl}/api/auth/device`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: hostname,
			editor: "claude-code",
			platform,
		}),
	});
	if (!res.ok) throw new Error(`could not start activation (HTTP ${res.status})`);
	return (await res.json()) as DeviceInit;
}

export type PollResult =
	| { status: "pending" }
	| { status: "denied"; error: string }
	| { status: "ok"; token: string };

export async function pollDeviceToken(
	apiUrl: string,
	deviceCode: string,
): Promise<PollResult> {
	const res = await fetch(`${apiUrl}/api/auth/device/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ device_code: deviceCode }),
	});

	const body = (await res.json().catch(() => ({}))) as {
		access_token?: unknown;
		error?: unknown;
	};

	if (res.ok && typeof body.access_token === "string") {
		return { status: "ok", token: body.access_token };
	}
	// `authorization_pending` is the normal answer while someone is still in
	// the browser, not a failure to report.
	if (body.error === "authorization_pending") return { status: "pending" };
	return {
		status: "denied",
		error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
	};
}

/** The wire shape, snake_case, matching what the CLI and editors send. */
export type Heartbeat = {
	entity: string;
	type: "file" | "app";
	time: number;
	category: "coding" | "ai";
	project_git_remote?: string;
	branch?: string;
	language?: string;
	editor: string;
	plugin: string;
	is_write?: boolean;
	lines_added?: number;
	lines_deleted?: number;
	ai_lines_added?: number;
	ai_lines_deleted?: number;
	ai_line_changes?: number;
	ai_tool: "claude-code";
	ai_session?: string;
	ai_model?: string;
	ai_input_tokens?: number;
	ai_output_tokens?: number;
	ai_cache_read_tokens?: number;
	ai_cache_write_tokens?: number;
};

/**
 * Turn a parsed session into heartbeats.
 *
 * One per file the assistant edited, plus one carrying the session's token
 * totals. The token beat is `type: "app"` rather than a file, because
 * attributing a whole conversation's tokens to whichever file happened to be
 * edited last would make the per-file numbers nonsense.
 *
 * `ai_lines_added` is set from the assistant's own patch summary. That is the
 * field the dashboard needs to say what share of the code an assistant wrote —
 * and it is exactly the field that was never being populated.
 */
export function toHeartbeats(
	session: Session,
	gitRemote: string,
	pluginVersion: string,
): Heartbeat[] {
	const plugin = `claude-code-inlinr/${pluginVersion}`;
	const base = {
		editor: "claude-code",
		plugin,
		ai_tool: "claude-code" as const,
		ai_session: session.id,
		...(session.model ? { ai_model: session.model } : {}),
		...(gitRemote ? { project_git_remote: gitRemote } : {}),
	};

	const beats: Heartbeat[] = session.edits.map((edit) => ({
		...base,
		entity: edit.path,
		type: "file",
		time: Date.parse(edit.timestamp) / 1000,
		category: "coding",
		is_write: true,
		lines_added: edit.linesAdded,
		lines_deleted: edit.linesRemoved,
		ai_lines_added: edit.linesAdded,
		ai_lines_deleted: edit.linesRemoved,
		ai_line_changes: edit.lineChanges,
	}));

	const t = session.tokens;
	const anyTokens =
		t.input > 0 || t.output > 0 || t.cacheRead > 0 || t.cacheWrite > 0;
	if (anyTokens && session.lastSeen) {
		beats.push({
			...base,
			entity: "claude-code",
			type: "app",
			time: Date.parse(session.lastSeen) / 1000,
			category: "ai",
			ai_input_tokens: t.input,
			ai_output_tokens: t.output,
			ai_cache_read_tokens: t.cacheRead,
			ai_cache_write_tokens: t.cacheWrite,
		});
	}

	return beats;
}

export async function sendHeartbeats(
	apiUrl: string,
	token: string,
	beats: Heartbeat[],
): Promise<{ accepted: number }> {
	if (beats.length === 0) return { accepted: 0 };
	const res = await fetch(`${apiUrl}/api/v1/heartbeats`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(beats),
	});
	if (!res.ok) throw new Error(`ingest rejected the batch (HTTP ${res.status})`);
	const body = (await res.json().catch(() => ({}))) as { accepted?: unknown };
	return { accepted: typeof body.accepted === "number" ? body.accepted : 0 };
}

/**
 * Revoke this machine's token, server side as well as locally.
 *
 * Deleting the local file alone would leave a device listed as connected
 * forever with no way to tell it is dead — and a token that still works if
 * anyone recovers the file.
 */
export async function revokeDevice(
	apiUrl: string,
	token: string,
): Promise<boolean> {
	try {
		const res = await fetch(`${apiUrl}/api/auth/device/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		});
		return res.ok;
	} catch {
		return false;
	}
}
