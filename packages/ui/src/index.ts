// Shared design tokens for every Keepwell surface.
//
// The language is a ledger, ported from the Jod design system: warm paper, ink, a cloth-bound
// navigation "binding" with gold-foil lettering, ruled tables, stamped status words, a sealed record.
// The colours are PayPal's: navy `#003087` for the binding, PayPal blue `#0070ba` for ink and actions,
// PayPal gold `#ffc439` for foil and highlights. The chart colours (blue, ochre, teal) were run through
// the data-viz palette validator on both papers (lightness band, chroma, colour-blind separation, 3:1).
// Text colours are checked for contrast in index.test.ts.
const light = {
  // paper
  background: "#f4f1ea",
  surface: "#fffdf9",
  surfaceMuted: "#f0ece3",
  border: "#e4dfd3",
  borderStrong: "#cec7b7",
  // ink
  text: "#1b1d22",
  muted: "#4d5059",
  subtle: "#757883",
  // PayPal blue, as ink
  primary: "#005ea6",
  primaryHover: "#003087",
  primaryText: "#ffffff",
  primarySoft: "#e7f0fa",
  accent: "#0070ba",
  // status: ledger green, ochre, vermilion
  success: "#17603a",
  successSoft: "#eaf4ed",
  warning: "#7d4806",
  warningSoft: "#fbf3e2",
  danger: "#952f21",
  dangerSoft: "#fbeeeb",
  // charts (validated on surface)
  series1: "#0070ba",
  series2: "#bf8420",
  series3: "#22a08c",
  // the binding: PayPal navy cloth, gold foil
  bindBg: "#003087",
  bindDeep: "#00205c",
  bindText: "#eef3fb",
  bindMuted: "#a9bde6",
  bindGold: "#ffc439",
  bindHover: "rgb(255 255 255 / 0.07)",
  bindThread: "rgb(255 196 57 / 0.4)",
  // the margin line and the highlighter
  marginLine: "rgb(0 156 222 / 0.45)",
  highlight: "rgb(255 196 57 / 0.16)",
  // the seal
  sealInk: "#003087",
  sealBroken: "#b73b2b",
  shadow: "0 1px 0 rgb(40 50 70 / 0.05), 0 14px 28px -24px rgb(40 50 70 / 0.45)",
} as const;

const dark: Record<keyof typeof light, string> = {
  background: "#13110f",
  surface: "#1c1916",
  surfaceMuted: "#0f0d0b",
  border: "#2d2823",
  borderStrong: "#40382f",
  text: "#eee8dc",
  muted: "#b5ac9e",
  subtle: "#8a8275",
  primary: "#7fb6e8",
  primaryHover: "#a4cbf0",
  primaryText: "#0a1f38",
  primarySoft: "#14263b",
  accent: "#4799de",
  success: "#7bd8a4",
  successSoft: "#112419",
  warning: "#f0bd62",
  warningSoft: "#2a1f0e",
  danger: "#f59d8f",
  dangerSoft: "#2d1512",
  series1: "#4799de",
  series2: "#b08a24",
  series3: "#279f8b",
  bindBg: "#00184a",
  bindDeep: "#000f33",
  bindText: "#dde7f7",
  bindMuted: "#8fa6d4",
  bindGold: "#f0b83a",
  bindHover: "rgb(255 255 255 / 0.06)",
  bindThread: "rgb(240 184 58 / 0.3)",
  marginLine: "rgb(71 153 222 / 0.35)",
  highlight: "rgb(255 196 57 / 0.09)",
  sealInk: "#93bff0",
  sealBroken: "#f07a6a",
  shadow: "0 1px 0 rgb(0 0 0 / 0.3), 0 14px 28px -22px rgb(0 0 0 / 0.8)",
};

export const tokens = {
  color: { light, dark },
  space: { xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px" },
  radius: { sm: "4px", md: "5px", lg: "6px", pill: "999px" },
  font: {
    // Newsreader, IBM Plex Sans and IBM Plex Mono when the page loads them; good system faces otherwise.
    serif: '"Newsreader", ui-serif, "Iowan Old Style", Georgia, "Times New Roman", serif',
    sans: '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
} as const;

export type Theme = keyof typeof tokens.color;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The theme to start with: the viewer's saved choice, else the operating system's setting. */
export function preferredTheme(saved: string | null, systemPrefersDark: boolean): Theme {
  if (saved === "light" || saved === "dark") return saved;
  return systemPrefersDark ? "dark" : "light";
}

/** CSS custom properties shared by every surface. */
export function themeStyles(theme: Theme): string {
  const colors = Object.entries(tokens.color[theme]).map(([name, value]) => `--kw-${kebab(name)}:${value}`);
  const space = Object.entries(tokens.space).map(([name, value]) => `--kw-space-${name}:${value}`);
  const radius = Object.entries(tokens.radius).map(([name, value]) => `--kw-radius-${name}:${value}`);
  const fonts = Object.entries(tokens.font).map(([name, value]) => `--kw-font-${name}:${value}`);
  return `:root{color-scheme:${theme};${[...colors, ...space, ...radius, ...fonts].join(";")}}`;
}
