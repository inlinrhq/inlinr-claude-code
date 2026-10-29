import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Repo, ResolveRepo } from "./api";

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return "";
  }
}

function firstRemote(root: string): string {
  const name = git(root, ["remote"]).split("\n")[0]?.trim();
  return name ? git(root, ["remote", "get-url", name]) : "";
}

/**
 * The repository a directory belongs to, cached for the length of one sync.
 *
 * A deleted file's directory may be gone too, so the nearest existing parent
 * stands in for it — it is in the same repository.
 */
export function repoResolver(): ResolveRepo {
  const cache = new Map<string, Repo | null>();
  const lookup = (dir: string): Repo | null => {
    const root = git(dir, ["rev-parse", "--show-toplevel"]);
    if (!root) return null;
    // `origin` first, else the first remote — the same rule as the CLI and
    // the VS Code extension, so a fork whose only remote is `upstream` is
    // tracked here too instead of silently skipped.
    const remote =
      git(root, ["remote", "get-url", "origin"]) || firstRemote(root);
    // A repository with no remote (not pushed yet, or local only) goes by
    // its folder's name. A folder outside any repository stays skipped: it
    // is often the parent of several, whose activity belongs to them.
    const project = remote ? undefined : basename(root);
    if (!remote && !project) return null;
    // Checked out now, not when the line was written — the transcript's
    // own `gitBranch` is the starting folder's, wrong for any other repo.
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { remote, project, root, branch: branch === "HEAD" ? "" : branch };
  };
  return (dir: string) => {
    let d = dir;
    while (d && !existsSync(d)) {
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
    if (!d) return null;
    const hit = cache.get(d);
    if (hit !== undefined) return hit;
    const repo = lookup(d);
    cache.set(d, repo);
    return repo;
  };
}
