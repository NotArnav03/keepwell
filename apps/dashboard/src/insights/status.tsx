import type { PanelFailure } from "./errors.js";

export function PanelLoading({ label }: { label: string }) {
  return (
    <p role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function PanelNotice({ failure }: { failure: PanelFailure }) {
  if (failure.kind === "unavailable") {
    return (
      <p className="notice" role="status">
        Not available yet.
      </p>
    );
  }
  return (
    <p className="notice notice-error" role="alert">
      {failure.message}
    </p>
  );
}

export function PanelEmpty({ message }: { message: string }) {
  return <p className="muted">{message}</p>;
}
