import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("Build the companion on Windows.");
fs.mkdirSync("dist", { recursive: true });
const output = path.resolve("dist/PNGCalls-Companion.exe");
fs.copyFileSync(process.execPath, output);
const generated = spawnSync(process.execPath, ["--experimental-sea-config", "companion/sea-config.json"], { stdio: "inherit" });
if (generated.status !== 0) process.exit(generated.status || 1);
const postject = path.resolve("node_modules/postject/dist/cli.js");
const injected = spawnSync(process.execPath, [postject, output, "NODE_SEA_BLOB", path.resolve("dist/pngcalls-companion.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit" });
if (injected.status !== 0) process.exit(injected.status || 1);
fs.rmSync("dist/pngcalls-companion.blob", { force: true });
console.log(`Built ${output}`);
