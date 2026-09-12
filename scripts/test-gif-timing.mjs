import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspectGifTiming } from "../public/gif-timing.js";

const bytes = await readFile(new URL("../public/assets/zeph.gif", import.meta.url));
const timing = inspectGifTiming(bytes);
assert.ok(timing.frames > 0, "The GIF inspector should find animation frames");
assert.ok(timing.durationMs >= 250, "The GIF inspector should return a safe playback duration");
console.log(`GIF timing inspection passed (${timing.frames} frames, ${timing.durationMs}ms)`);
