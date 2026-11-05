import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.js";

function feed(chunks: string[]) {
  const parser = createSseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe("SSE parser", () => {
  it("joins a JSON frame split across chunks", () => {
    const items = feed(['event: delta\ndata: {"type":"delta","te', 'xt":"Hi"}\n\n']);
    expect(items).toEqual([{ ok: true, event: "delta", data: { type: "delta", text: "Hi" } }]);
  });

  it("accepts CRLF, including a CR/LF pair split across chunks", () => {
    const items = feed(["event: done\r", '\ndata: {"type":"done","flagged":true}\r\n\r\n']);
    expect(items).toEqual([{ ok: true, event: "done", data: { type: "done", flagged: true } }]);
  });

  it("joins multi-line data before parsing JSON", () => {
    const items = feed(['event: delta\ndata: {"text":\ndata: "ab"}\n\n']);
    expect(items).toEqual([{ ok: true, event: "delta", data: { text: "ab" } }]);
  });

  it("reports a frame whose data is not JSON", () => {
    const items = feed(["event: delta\ndata: {not json}\n\n"]);
    expect(items).toEqual([{ ok: false, event: "delta", data: "{not json}" }]);
  });

  it("ignores comment lines", () => {
    const items = feed([
      ': keep-alive\nevent: tool_call\ndata: {"type":"tool_call","tool":"list_plans"}\n\n',
    ]);
    expect(items).toEqual([
      { ok: true, event: "tool_call", data: { type: "tool_call", tool: "list_plans" } },
    ]);
  });

  it("holds a trailing partial frame until the blank line arrives", () => {
    const parser = createSseParser();
    expect(parser.push('event: delta\ndata: {"text":"Hi"}')).toEqual([]);
    expect(parser.push("\n\n")).toEqual([{ ok: true, event: "delta", data: { text: "Hi" } }]);
  });

  it("returns unknown event names instead of throwing", () => {
    const items = feed(['event: ping\ndata: {"type":"ping"}\n\n']);
    expect(items).toEqual([{ ok: true, event: "ping", data: { type: "ping" } }]);
  });
});
