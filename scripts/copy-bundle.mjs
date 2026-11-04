// The plugin runs plugin/dist/index.js. dist/index.js at the root is the same
// file, kept for what downloads it by that path: inlinr.com pins it by commit
// for cloud setup lines, and repository hooks written for releases before
// 0.8.1 fetch it from main.
import { copyFileSync } from "node:fs";

copyFileSync("plugin/dist/index.js", "dist/index.js");
