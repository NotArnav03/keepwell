// Same as @keepwell/contracts/fakes' uuidv7, which the runtime build can't import. Move both to
// one shared helper when the platform grows one.

/** RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, then randomness. Sorts by creation time. */
export function uuidv7(nowMs: number): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let t = nowMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
