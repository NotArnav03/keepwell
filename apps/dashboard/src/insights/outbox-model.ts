/** Append a page, skipping ids already on screen, and keep the existing order. */
export function mergeOutbox<T extends { id: string }>(existing: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(existing.map((item) => item.id));
  const merged = [...existing];
  for (const item of page) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}
