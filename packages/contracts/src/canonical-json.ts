// Deterministic JSON: object keys sorted at every depth, array order kept, `undefined` dropped
// (as JSON.stringify does). Anything that is hashed (audit chain, consent offerHash) goes
// through this, so two services that build the same object get the same hash.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") return sortKeys((withToJson.toJSON as () => unknown)());
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}
