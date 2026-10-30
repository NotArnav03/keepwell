/**
 * Same as apps/api/src/db.ts: Neon's sslmode=require becomes verify-full. pg already treats them
 * alike and warns unless the stricter mode is spelled out.
 */
export function withStrictSsl(connectionString: string): string {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  if (mode === "prefer" || mode === "require" || mode === "verify-ca")
    url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}
