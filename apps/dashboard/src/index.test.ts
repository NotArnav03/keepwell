import { describe, expect, it } from "vitest";
import { renderDashboardShell, renderLoginForm } from "./index.js";

describe("merchant dashboard shell", () => {
  it("marks the current section and escapes merchant-provided text", () => {
    const html = renderDashboardShell({ name: '<img src=x onerror="alert(1)">', email: "x@y.test" });

    expect(html).toContain('aria-current="page"');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<span><img src=x");
  });

  it("supports the shared dark theme and navigation", () => {
    const html = renderDashboardShell({ name: "Pantry Plan", email: "owner@example.test" }, "audit", "dark");

    expect(html).toContain("color-scheme:dark");
    expect(html).toContain('href="#audit" aria-current="page">Audit log</a>');
    expect(html).toContain("<h1>Audit log</h1>");
  });

  it("uses labeled, browser-autofill-aware merchant login fields", () => {
    const html = renderLoginForm();

    expect(html).toContain('action="/v1/m/auth/login"');
    expect(html).toContain('for="email"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('type="submit"');
  });
});
