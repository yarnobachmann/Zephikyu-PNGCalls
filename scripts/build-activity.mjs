import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: projectDir,
  entryPoints: [path.join(projectDir, "activity", "activity.js")],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  target: ["chrome110", "firefox110", "safari16"],
  outfile: path.join(projectDir, "public", "activity.js"),
});

console.log("Built public/activity.js");
