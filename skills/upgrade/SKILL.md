---
name: upgrade
description: Upgrade an npm dependency of this codebase with what inlinr knows about the versions in between - breaking changes, migration guides, advisories - then fix the code and run the checks. Use when the user types /inlinr:upgrade, or asks to upgrade, bump or migrate an npm package.
argument-hint: <package> [version]
---

Upgrade the npm package named in the arguments (`$ARGUMENTS`: a package name,
then optionally the version to go to; the latest when it is left out).

If no package is named: when the `inlinr` MCP server is connected, call its
`my_upgrades` tool and offer the first few entries (security fixes first);
otherwise ask the user which package to upgrade. Do not guess.

## 1. Where it stands

- Find the package.json files that declare the package (dependencies,
  devDependencies, peerDependencies, optionalDependencies), workspaces
  included, and the range each declares.
- The version installed now: `node_modules/<package>/package.json`'s
  `version` (from the folder of each package.json, then the root), else the
  lockfile, else the version the range starts at (`^18.2.0` → `18.2.0`).
- The package manager: `pnpm-lock.yaml` → pnpm, `bun.lock` or `bun.lockb` →
  bun, `yarn.lock` → yarn, else npm.

## 2. What changes

Read what changes between the installed version and the target. No account or
key is needed; only the package name and the two versions leave the machine:

```bash
curl -sf "https://inlinr.com/api/v1/packages/<package>/upgrade?from=<installed>&to=<target>"
```

(Or the `upgrade_notes` tool of the `inlinr` MCP server, which calls the same
endpoint.) Leave `to` out to go to the latest; the answer's `to` says which
version that is. Scoped names go in the path as they are
(`/api/v1/packages/@tanstack/react-router/upgrade?...`).

The answer lists, read from every release note in between:
`breaking`, `deprecations`, `security`, `features`, `fixes` (each
`{ version, markdown }`), `guides` (`{ label, url }`: migration guides, read
them first), `fixed_advisories` and `remaining_advisories`, and
`releases_without_notes` (how many notes are missing: the lists are not the
whole story when it is high). `majors_without_breaking` counts major versions
whose notes name no breaking change, which usually means they live in a guide.

Fetch the guides with WebFetch when there are any. If the answer has no
breaking changes for a major upgrade, say so and read the package's own
release notes or docs before going on.

Then tell the user, briefly: from and to, the breaking changes that matter, the
advisories this fixes and any that remain, and the guide you will follow. For
a major upgrade, wait for their go ahead before changing anything.

## 3. Where the code uses it

Find every import of the package and its subpaths (`<package>`,
`<package>/...`): the `inlinr` MCP server's `find_usages` tool when it is
connected (searched locally, nothing is sent), otherwise a search of the source
files outside `node_modules` and build output. Match each breaking change
against those lines; that is the list of places to change.

## 4. Upgrade

1. Install the target with the package manager found above, as a dev
   dependency when it was one (`npm install -D`, `pnpm add -D`, `yarn add -D`,
   `bun add -d`), in each workspace that declares it.
2. Update peer dependencies the new version asks for.
3. Change the code the breaking changes and deprecations affect, following the
   guide. Keep the change to the upgrade: no unrelated refactoring.

## 5. Check

Run what the project has, from its package.json scripts: the type checker, the
linter, the tests, the build. Fix what fails because of the upgrade. Look for
new deprecation warnings in the output.

## 6. Report

Summarise: the versions, what you changed and where, the checks and their
results, any advisory still open on the new version, and anything the user
should check by hand (behaviour changes no check covers). Link the upgrade's
page: `https://inlinr.com/packages/<package>/upgrade/<installed>-<target>`.
