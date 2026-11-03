import {
  type CodexState,
  emptyCodexState,
  emptyGeminiState,
  type GeminiState,
  parseCodex,
  parseGemini,
} from "../agents";
import { sendHeartbeats, toHeartbeats } from "../api";
import {
  type Config,
  machineToken,
  save,
  saveMachineToken,
  tokenSource,
  tokenTag,
} from "../config";
import { repoResolver } from "../repo";
import { hasNew, readFrom, sessionFiles } from "../sessions";
import { isEmpty, parseTranscript, type Session } from "../transcript";
import { VERSION } from "../version";

export async function sync(
  config: Config,
  throttleSeconds: number,
): Promise<number> {
  const source = tokenSource(config);
  const deviceToken = source?.token ?? "";
  if (!deviceToken) {
    // Silent on purpose. A hook firing on every tool call must not print an
    // error into somebody's session because they have not activated yet.
    return 0;
  }

  if (source?.from === "plugin" && !machineToken()) {
    // Connected by a release before 0.7.0, nothing in config.toml: the
    // token moves there, once, and the inlinr extension and CLI use it
    // too. Same token, so the read positions stay as they are. A machine
    // whose config.toml holds another token keeps both: possibly two
    // accounts on purpose, which /inlinr:status points out.
    try {
      saveMachineToken(deviceToken);
      config = { ...config, deviceToken: "" };
      save(config, "set");
    } catch {
      // Not an inlinr token's shape, or config.toml not writable: it stays
      // where it was and keeps working.
    }
  }

  const tag = tokenTag(deviceToken);
  const otherToken = config.tokenTag != null && config.tokenTag !== tag;
  if (!config.lastParsedAt || otherToken) {
    // A token never activated by this plugin: from the environment, or the
    // machine's, saved by the CLI or VS Code. Tracking starts now, for the
    // same reason it does on activation. In a cloud session the
    // SessionStart hook gets here before any work has happened. A token
    // that changed (signed out, then in again elsewhere) starts over too:
    // what was done while signed out is not sent afterwards.
    save({
      ...config,
      tokenTag: tag,
      lastParsedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      files: otherToken ? {} : config.files,
    });
    return 0;
  }

  if (throttleSeconds > 0 && config.lastSyncAt) {
    const age = Date.now() - Date.parse(config.lastSyncAt);
    if (Number.isFinite(age) && age < throttleSeconds * 1000) return 0;
  }

  const since = new Date(config.lastParsedAt);
  const all = sessionFiles();
  const files: Config["files"] = {};
  const beats = [];
  const resolve = repoResolver();

  for (const t of all) {
    const state = config.files[t.key];
    if (!hasNew(config, t)) {
      // Kept only while the file exists, so the map does not grow with
      // every session ever deleted.
      if (state) files[t.key] = state;
      continue;
    }

    // A file that shrank was rewritten; start it over.
    const offset = state && state.offset <= t.size ? state.offset : 0;
    let chunk: { text: string; end: number };
    try {
      chunk = readFrom(t.path, offset, t.size);
    } catch {
      if (state) files[t.key] = state;
      continue;
    }

    // Only a file read for the first time needs the floor; a known one
    // resumes exactly where it stopped.
    const floor = state ? null : since;
    const resumed = state && offset > 0 ? state : null;
    let session: Session | null;
    if (t.tool === "codex") {
      const read = parseCodex(chunk.text, {
        since: floor,
        state: (resumed?.agent as CodexState | undefined) ?? emptyCodexState(),
      });
      session = read.session;
      files[t.key] = { offset: chunk.end, agent: read.state };
    } else if (t.tool === "gemini-cli") {
      const read = parseGemini(chunk.text, {
        since: floor,
        state:
          (resumed?.agent as GeminiState | undefined) ?? emptyGeminiState(),
        root: t.root,
      });
      session = read.session;
      files[t.key] = { offset: chunk.end, agent: read.state };
    } else {
      session = parseTranscript(chunk.text, {
        since: floor,
        carry: resumed?.carry ?? null,
        subagent: t.subagent,
      });
      files[t.key] = {
        offset: chunk.end,
        carry: session?.carry ?? state?.carry ?? null,
      };
    }
    if (!session || isEmpty(session)) continue;

    beats.push(...toHeartbeats(session, resolve, VERSION));
  }

  // Positions are saved only once the beats have landed. A failed send
  // throws past this point, and the next sync reads the same lines again.
  if (beats.length > 0) {
    await sendHeartbeats(config.apiUrl, deviceToken, beats);
  }

  save({
    ...config,
    // Recorded on the first sync of a release that knows the tag.
    tokenTag: tag,
    files,
    lastSyncAt: new Date().toISOString(),
  });
  return 0;
}
