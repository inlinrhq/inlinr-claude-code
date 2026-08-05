// One version, three files. They drifted once already — plugin.json said 0.4.0
// while marketplace.json still said 0.2.0, which is exactly what produces
// "I installed it and nothing changed".
import { readFileSync } from "node:fs";
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const plugin = read(".claude-plugin/plugin.json").version;
const market = read(".claude-plugin/marketplace.json").plugins[0].version;
const pkg = read("package.json").version;
const src = readFileSync("src/index.ts", "utf8").match(/const VERSION = "([^"]+)"/)?.[1];
const all = { plugin, market, pkg, src };
const unique = [...new Set(Object.values(all))];
if (unique.length !== 1) {
  console.error("version mismatch:", all);
  process.exit(1);
}
console.log("version:", unique[0]);
