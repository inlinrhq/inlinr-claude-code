import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save, saveMachineToken, tokenTag } from "../config";
import { sync } from "./sync";

let home = "";
let envToken: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inlinr-sync-"));
  process.env.INLINR_HOME = home;
  envToken = process.env.INLINR_TOKEN;
  delete process.env.INLINR_TOKEN;
});
afterEach(() => {
  delete process.env.INLINR_HOME;
  if (envToken !== undefined) process.env.INLINR_TOKEN = envToken;
  rmSync(home, { recursive: true, force: true });
});

const OLD = "in_d_the_token_before_signing_out_00";
const NEW = "in_d_the_token_after_signing_in_again";

test("a machine connected by the CLI starts tracking now", async () => {
  saveMachineToken(NEW);
  await sync(load(), 0);
  const config = load();
  expect(config.tokenTag).toBe(tokenTag(NEW));
  expect(Date.now() - Date.parse(config.lastParsedAt ?? "")).toBeLessThan(5000);
});

test("another token starts over instead of sending the time signed out", async () => {
  saveMachineToken(NEW);
  save({
    ...load(),
    tokenTag: tokenTag(OLD),
    lastParsedAt: "2026-10-01T00:00:00.000Z",
    files: { "a.jsonl": { offset: 10 } },
  });
  await sync(load(), 0);
  const config = load();
  expect(config.tokenTag).toBe(tokenTag(NEW));
  expect(config.files).toEqual({});
  expect(config.lastParsedAt).not.toBe("2026-10-01T00:00:00.000Z");
});
