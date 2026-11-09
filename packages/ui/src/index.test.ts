import { describe, expect, it } from "vitest";
import { preferredTheme, themeStyles, tokens, type Theme } from "./index.js";

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r = 0, g = 0, bl = 0] = channels.map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const themes: Theme[] = ["light", "dark"];

describe("shared UI theme tokens", () => {
  it("defines the same tokens in light and dark", () => {
    expect(Object.keys(tokens.color.dark).sort()).toEqual(Object.keys(tokens.color.light).sort());
  });

  it.each(themes)("keeps the binding's lettering and gold foil readable on the cloth in %s", (theme) => {
    const c = tokens.color[theme];
    expect(contrast(c.bindText, c.bindBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.bindMuted, c.bindBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.bindGold, c.bindBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.bindGold, c.bindDeep)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)("keeps every text colour readable (4.5:1) on its surfaces in %s", (theme) => {
    const c = tokens.color[theme];
    for (const surface of [c.surface, c.background, c.surfaceMuted]) {
      expect(contrast(c.text, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.muted, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.primary, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.danger, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.success, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.warning, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)("keeps button text and status chips readable in %s", (theme) => {
    const c = tokens.color[theme];
    expect(contrast(c.primaryText, c.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.primary, c.primarySoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.success, c.successSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.warning, c.warningSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.danger, c.dangerSoft)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)("keeps all three chart colours visible (3:1) against the surface in %s", (theme) => {
    const c = tokens.color[theme];
    for (const mark of [c.series1, c.series2, c.series3]) {
      expect(contrast(mark, c.surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it("generates theme-scoped CSS variables, kebab-cased", () => {
    expect(themeStyles("light")).toContain("--kw-background:#f4f1ea");
    expect(themeStyles("dark")).toContain("--kw-background:#13110f");
    expect(themeStyles("dark")).toContain("--kw-surface-muted:#0f0d0b");
    expect(themeStyles("dark")).toContain("--kw-space-md:16px");
    expect(themeStyles("dark")).toContain("--kw-radius-md:5px");
    expect(themeStyles("dark")).toContain("color-scheme:dark");
  });

  it("starts from the saved theme, then the system setting", () => {
    expect(preferredTheme("dark", false)).toBe("dark");
    expect(preferredTheme("light", true)).toBe("light");
    expect(preferredTheme(null, true)).toBe("dark");
    expect(preferredTheme("junk", false)).toBe("light");
  });
});
