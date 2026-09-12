export function inspectGifTiming(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") throw new Error("Not a GIF image");
  if (bytes.length < 13) throw new Error("Incomplete GIF image");

  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (2 ** ((bytes[10] & 0x07) + 1));
  let pendingDelay = 0;
  let durationMs = 0;
  let frames = 0;

  const skipSubBlocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (!length) return;
      offset += length;
    }
  };

  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) {
        const length = bytes[offset++];
        if (length >= 4 && offset + length <= bytes.length) pendingDelay = bytes[offset + 1] | (bytes[offset + 2] << 8);
        offset += length;
        if (bytes[offset] === 0) offset += 1;
      } else {
        skipSubBlocks();
      }
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) break;
    const packed = bytes[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    offset += 1;
    skipSubBlocks();
    frames += 1;
    durationMs += Math.max(20, pendingDelay * 10);
    pendingDelay = 0;
  }

  return { frames, durationMs: Math.max(250, durationMs) };
}
