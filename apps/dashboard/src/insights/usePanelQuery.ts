import { useEffect, useRef, useState } from "react";
import { isAbortError, panelFailure, type PanelFailure } from "./errors.js";

export type PanelQuery<T> =
  { status: "loading" } | { status: "ready"; data: T } | { status: "failed"; failure: PanelFailure };

/**
 * Reload whenever `key` changes. The loader is read from a ref so a new function
 * identity on each render does not refetch by itself.
 */
export function usePanelQuery<T>(key: string, load: (signal: AbortSignal) => Promise<T>): PanelQuery<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [query, setQuery] = useState<PanelQuery<T>>({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setQuery({ status: "loading" });
    loadRef.current(ctrl.signal).then(
      (data) => {
        if (active) setQuery({ status: "ready", data });
      },
      (cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        setQuery({ status: "failed", failure: panelFailure(cause) });
      },
    );
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [key]);

  return query;
}
