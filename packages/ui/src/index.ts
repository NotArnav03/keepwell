// Shared design tokens. Keep dashboard colors and spacing consistent across themes.
export const tokens = {
  color: {
    light: {
      background: "#f7f8fa",
      surface: "#ffffff",
      text: "#17202a",
      muted: "#536273",
      border: "#d7dee7",
      primary: "#1457a6",
      success: "#176b45",
      warning: "#7a4b00",
      danger: "#a32632",
    },
    dark: {
      background: "#111820",
      surface: "#1b2632",
      text: "#f2f5f8",
      muted: "#bdc8d4",
      border: "#405060",
      primary: "#8dbdff",
      success: "#7cdaa7",
      warning: "#ffd080",
      danger: "#ff9da5",
    },
  },
  space: { xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px" },
  radius: { sm: "6px", md: "10px", pill: "999px" },
} as const;

export type Theme = keyof typeof tokens.color;

/** CSS custom properties shared by dashboard surfaces. */
export function themeStyles(theme: Theme): string {
  const colors = tokens.color[theme];
  return `:root{color-scheme:${theme};${Object.entries(colors)
    .map(([name, value]) => `--kw-${name}:${value}`)
    .join(
      ";",
    )};--kw-space-xs:${tokens.space.xs};--kw-space-sm:${tokens.space.sm};--kw-space-md:${tokens.space.md};--kw-space-lg:${tokens.space.lg};--kw-space-xl:${tokens.space.xl};--kw-radius-sm:${tokens.radius.sm};--kw-radius-md:${tokens.radius.md}}`;
}
