import { themeStyles, type Theme } from "@keepwell/ui";

export interface MerchantIdentity {
  name: string;
  email: string;
}

const navigation = [
  ["overview", "Overview"],
  ["subscribers", "Subscribers"],
  ["timeline", "Timeline"],
  ["audit", "Audit log"],
  ["policies", "Policies"],
  ["settings", "Settings"],
] as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
}

/** Render the authenticated merchant shell; data views are loaded from the API. */
export function renderDashboardShell(
  merchant: MerchantIdentity,
  active: (typeof navigation)[number][0] = "overview",
  theme: Theme = "light",
): string {
  const links = navigation
    .map(([id, label]) => `<a href="#${id}"${id === active ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keepwell · Merchant</title><style>${themeStyles(theme)}
*{box-sizing:border-box}body{margin:0;background:var(--kw-background);color:var(--kw-text);font:16px/1.5 system-ui,sans-serif}a{color:var(--kw-primary)}button,a{min-height:44px}a:focus-visible,button:focus-visible{outline:3px solid var(--kw-primary);outline-offset:2px}.layout{min-height:100vh;display:grid;grid-template-columns:240px 1fr}.sidebar{padding:var(--kw-space-lg);background:var(--kw-surface);border-right:1px solid var(--kw-border)}.brand{font-weight:750;font-size:1.35rem}.nav{display:grid;gap:var(--kw-space-xs);margin-top:var(--kw-space-xl)}.nav a{padding:var(--kw-space-sm);border-radius:var(--kw-radius-sm);text-decoration:none}.nav a[aria-current=page]{background:var(--kw-background);font-weight:650}.main{min-width:0}.topbar{display:flex;justify-content:space-between;align-items:center;padding:var(--kw-space-md) var(--kw-space-xl);background:var(--kw-surface);border-bottom:1px solid var(--kw-border)}.content{max-width:1200px;margin:auto;padding:var(--kw-space-xl)}.panel{padding:var(--kw-space-lg);background:var(--kw-surface);border:1px solid var(--kw-border);border-radius:var(--kw-radius-md)}@media(max-width:700px){.layout{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid var(--kw-border)}.nav{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:var(--kw-space-md)}.content{padding:var(--kw-space-md)}.topbar{padding:var(--kw-space-md)}}
</style></head>
<body><div class="layout"><aside class="sidebar"><a class="brand" href="#overview" aria-label="Keepwell home">Keepwell</a><nav class="nav" aria-label="Main navigation">${links}</nav></aside><div class="main"><header class="topbar"><span>Merchant workspace</span><div><span>${escapeHtml(merchant.name)}</span> <button type="button" aria-label="Sign out ${escapeHtml(merchant.name)}">Sign out</button></div></header><main class="content" id="main-content"><h1>${navigation.find(([id]) => id === active)?.[1] ?? "Overview"}</h1><section class="panel" aria-label="Dashboard content"><p>Workspace data will appear here.</p></section></main></div></div></body></html>`;
}

/** A sign-in form that posts credentials to the merchant auth endpoint. */
export function renderLoginForm(): string {
  return `<form action="/v1/m/auth/login" method="post"><h1>Sign in to Keepwell</h1><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form>`;
}
