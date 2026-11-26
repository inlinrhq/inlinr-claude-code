import { tmpdir } from "node:os";

/**
 * The one project the time of every temporary folder goes to. inlinr marks
 * this name "Temporary?" (`looksTemporary` in inlinr-web).
 */
export const SCRATCH_PROJECT = "scratch";

/**
 * Is this repository's root a folder agents and quick tests work in: the
 * system's temporary folder, a scratchpad, Claude Code's worktrees, a cache?
 *
 * Only asked of a repository with no remote, which would otherwise become a
 * project named after its folder (`wt-1188m`, `kw-2202`); it goes to
 * `SCRATCH_PROJECT` instead. A worktree with a
 * remote stays its repository's. The same rule as the VS Code extension's
 * `folder-project.ts`.
 */
export function isTemporaryRoot(root: string, temp = tmpdir()): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const path = norm(root);
  const system = norm(temp);
  if (system && (path === system || path.startsWith(`${system}/`))) {
    return true;
  }
  if (
    /^(\/private)?\/(tmp|var\/tmp|var\/folders)(\/|$)/.test(path) ||
    /^[a-z]:\/(windows\/)?te?mp(\/|$)/.test(path)
  ) {
    return true;
  }
  const parts = path.split("/");
  return parts.some(
    (s, i) =>
      s === "scratchpad" ||
      s === ".cache" ||
      (s === ".claude" && parts[i + 1] === "worktrees") ||
      (s === "appdata" && parts[i + 1] === "local" && parts[i + 2] === "temp"),
  );
}
