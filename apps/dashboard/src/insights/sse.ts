/**
 * Incremental SSE reader (WHATWG event stream). Frames may arrive split across chunks.
 * A frame is emitted only when its terminating blank line has arrived, so a trailing
 * partial frame stays buffered. Comment lines (starting with ":") are ignored.
 * Unknown field names are ignored. `data` lines are joined with "\n", then parsed as JSON.
 */

export interface SseOk {
  ok: true;
  event: string;
  data: unknown;
}

export interface SseBad {
  ok: false;
  event: string;
  data: string;
}

export type SseItem = SseOk | SseBad;

export function createSseParser(): { push(chunk: string): SseItem[] } {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = (): SseItem[] => {
    const name = eventName || "message";
    const raw = dataLines.join("\n");
    const hadData = dataLines.length > 0;
    eventName = "";
    dataLines = [];
    // A blank line with no data lines is a no-op, matching the spec (empty data is not dispatched).
    if (!hadData || raw === "") return [];
    try {
      const data: unknown = JSON.parse(raw);
      return [{ ok: true, event: name, data }];
    } catch {
      return [{ ok: false, event: name, data: raw }];
    }
  };

  const consumeLine = (line: string): SseItem[] => {
    if (line.startsWith(":")) return [];
    if (line === "") return dispatch();
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return [];
  };

  return {
    push(chunk: string): SseItem[] {
      buffer += chunk;
      const items: SseItem[] = [];
      for (;;) {
        const newline = buffer.indexOf("\n");
        const carriage = buffer.indexOf("\r");
        if (newline === -1 && carriage === -1) break;
        let index: number;
        let width: number;
        if (carriage !== -1 && (newline === -1 || carriage < newline)) {
          // A trailing CR might be the start of a CRLF split across chunks.
          if (carriage === buffer.length - 1) break;
          index = carriage;
          width = buffer[carriage + 1] === "\n" ? 2 : 1;
        } else {
          index = newline;
          width = 1;
        }
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + width);
        items.push(...consumeLine(line));
      }
      return items;
    },
  };
}
