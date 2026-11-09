import { useId } from "react";

// The audit chain's seal, drawn from its head hash. A guilloche (the interlaced engraving on banknotes
// and cheques, made to be hard to copy) whose curves are chosen by the hash's bytes, ringed by 64 ticks
// that are the hash itself (one tick per hex digit, its length the digit's value). Two different hashes
// give visibly different seals; the same hash always gives the same one. It is an aid to the eye, never
// the proof: the proof is the chain, and the Verify button re-checks it. A broken chain is drawn
// cracked, in the warning ink, and stamped as such.
//
// Ported from the Jod design system's Seal.

function bytesOf(hex: string): number[] {
  const clean = (hex || "")
    .replace(/[^0-9a-f]/gi, "")
    .padEnd(64, "0")
    .slice(0, 64);
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** One hypotrochoid, scaled to `radius`: the spirograph curve of banknote engraving. */
function guilloche(R: number, r: number, d: number, radius: number, turn: number): string {
  const loops = r / gcd(R, r);
  const steps = Math.min(2400, Math.max(360, Math.round(loops * 140)));
  const scale = radius / (R - r + d);
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  let path = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * loops;
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
    path += `${i === 0 ? "M" : "L"}${((x * cos - y * sin) * scale).toFixed(2)} ${((x * sin + y * cos) * scale).toFixed(2)}`;
  }
  return path;
}

export function Seal({
  root,
  caption,
  broken = false,
  size = 200,
  animate = true,
}: {
  /** The chain's head hash, 64 hex digits. */
  root: string;
  /** Around the rim, e.g. "AUDIT CHAIN · 81 ENTRIES". */
  caption: string;
  broken?: boolean;
  size?: number;
  animate?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const b = bytesOf(root);
  const hex = (root || "").toLowerCase().padEnd(64, "0").slice(0, 64);
  const ink = broken ? "var(--kw-seal-broken)" : "var(--kw-seal-ink)";

  const layers = [0, 1, 2].map((n) => {
    const R = 96 + ((b[n * 3] ?? 0) % 5) * 6;
    let r = 13 + ((b[n * 3 + 1] ?? 0) % 23);
    if (gcd(R, r) === r) r += 1; // a curve that closes after one loop is too plain
    const d = 18 + ((b[n * 3 + 2] ?? 0) % 44);
    const turn = (((b[9 + n] ?? 0) / 255) * Math.PI * 2) / 3;
    return guilloche(R, r, d, [66, 54, 40][n] ?? 40, turn);
  });

  const ticks = Array.from(hex)
    .map((c, i) => {
      const v = parseInt(c, 16);
      const a = (i / 64) * Math.PI * 2 - Math.PI / 2;
      const r1 = 80;
      const r2 = 82 + v * 0.9;
      return `M${(r1 * Math.cos(a)).toFixed(2)} ${(r1 * Math.sin(a)).toFixed(2)}L${(r2 * Math.cos(a)).toFixed(2)} ${(r2 * Math.sin(a)).toFixed(2)}`;
    })
    .join("");

  const crack = broken
    ? `M-118 ${-40 + ((b[20] ?? 0) % 30)}` +
      [0, 1, 2, 3, 4, 5]
        .map(
          (k) =>
            ` L${-80 + k * 40 + ((b[21 + k] ?? 0) % 14)} ${-30 + k * 14 + (((b[27 + (k % 4)] ?? 0) % 26) - 13)}`,
        )
        .join("") +
      " L120 50"
    : "";

  const rim = `${caption.toUpperCase()} · `;
  const ringId = `seal-ring-${id}`;

  return (
    <svg
      viewBox="-130 -130 260 260"
      width={size}
      height={size}
      role="img"
      aria-label={`Seal ${broken ? "(broken) " : ""}of the ${caption.toLowerCase()}, head ${hex.slice(0, 8)}…`}
      className={`seal ${animate ? "seal-animate" : ""}`}
    >
      <defs>
        <path id={ringId} d="M0,-113 A113,113 0 1,1 -0.01,-113" />
      </defs>
      <g fill="none" stroke={ink} strokeLinecap="round">
        <circle r="124" strokeWidth="2.2" />
        <circle r="119" strokeWidth="0.6" />
        <circle r="103" strokeWidth="0.6" />
        <circle r="98" strokeWidth="1.6" />
        <path d={ticks} strokeWidth="1.3" className="seal-ticks" />
        {layers.map((d, n) => (
          <path
            key={n}
            d={d}
            pathLength={1}
            strokeWidth={[0.55, 0.5, 0.45][n]}
            opacity={[0.95, 0.75, 0.6][n]}
            className="seal-curve"
            style={{ animationDelay: `${n * 0.25}s` }}
          />
        ))}
      </g>
      <text fill={ink} style={{ font: "600 9.6px var(--kw-font-mono)", letterSpacing: "0.12em" }}>
        <textPath
          href={`#${ringId}`}
          startOffset="0"
          textLength={2 * Math.PI * 113 - 6}
          lengthAdjust="spacing"
        >
          {rim.repeat(Math.max(1, Math.floor(110 / rim.length)))}
        </textPath>
      </text>
      <circle r="27" fill="var(--kw-surface)" stroke={ink} strokeWidth="1" />
      <text
        y="3"
        textAnchor="middle"
        fill={ink}
        style={{ font: "600 11px var(--kw-font-serif)", letterSpacing: "0.02em" }}
      >
        Keepwell
      </text>
      <text
        y="15"
        textAnchor="middle"
        fill={ink}
        style={{ font: "500 6.4px var(--kw-font-mono)", letterSpacing: "0.06em" }}
      >
        {hex.slice(0, 4)} {hex.slice(4, 8)}
      </text>
      {broken && (
        <g>
          <path d={crack} fill="none" stroke="var(--kw-surface)" strokeWidth="4.5" />
          <path d={crack} fill="none" stroke="var(--kw-seal-broken)" strokeWidth="1.2" />
          <g transform="rotate(-18)" className="seal-stamp">
            <rect
              x="-62"
              y="-16"
              width="124"
              height="32"
              rx="3"
              fill="var(--kw-surface)"
              stroke="var(--kw-seal-broken)"
              strokeWidth="2.4"
            />
            <text
              y="7"
              textAnchor="middle"
              fill="var(--kw-seal-broken)"
              style={{ font: "700 19px var(--kw-font-mono)", letterSpacing: "0.2em" }}
            >
              BROKEN
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
