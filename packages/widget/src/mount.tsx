import { render } from "preact";
import { css } from "./styles.js";
import { Widget, type WidgetProps } from "./widget.js";

/**
 * Opens the widget in its own Shadow DOM under `document.body`. Returns a function that removes it.
 * Focus goes back to whatever opened it (usually the merchant's cancel button).
 */
export function mount(props: Omit<WidgetProps, "onClose">, onClosed?: () => void): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = document.createElement("div");
  host.setAttribute("data-keepwell-widget", "");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  root.append(style);
  document.body.append(host);

  const unmount = () => {
    render(null, root);
    host.remove();
    opener?.focus();
    onClosed?.();
  };
  render(<Widget {...props} onClose={unmount} />, root);
  return unmount;
}
