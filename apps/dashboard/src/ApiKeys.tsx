import { useEffect, useState, type FormEvent } from "react";
import type {
  MerchantApiKeyScope,
  MerchantApiKeySummary,
  MerchantCreateApiKeyResponse,
} from "@keepwell/contracts";
import type { MerchantApi } from "./api.js";
import {
  claudeAddCommand,
  DEFAULT_SCOPES,
  mcpUrl,
  SCOPE_INFO,
  SCOPE_ORDER,
  toggleScope,
} from "./api-keys.js";

// Keys for the merchant MCP server: an outside agent such as Claude Desktop reads the merchant's
// numbers and may propose actions, which still wait in the Action queue for a click here.

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "Never");

export function ApiKeys({ api: client }: { api: MerchantApi }) {
  const [keys, setKeys] = useState<MerchantApiKeySummary[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<MerchantApiKeyScope[]>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<MerchantCreateApiKeyResponse | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = () =>
    client
      .apiKeys()
      .then((list) => setKeys(list.keys))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Keys unavailable."));
  useEffect(() => {
    void load();
  }, [client]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setCreated(await client.createApiKey({ name, scopes }));
      setName("");
      setScopes(DEFAULT_SCOPES);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The key could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      await client.deleteApiKey(id);
      setConfirming(null);
      if (created?.key.id === id) setCreated(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The key could not be revoked.");
    } finally {
      setBusy(false);
    }
  }

  const url = mcpUrl(import.meta.env.VITE_API_BASE_URL);

  return (
    <>
      <header className="page-heading">
        <h1>API keys</h1>
        <p>Let an AI assistant such as Claude Desktop read your retention numbers and propose actions</p>
      </header>
      <p className="notice">
        A key opens the merchant MCP server. It can read what its scopes allow. It can never change a
        subscription, a price or your policy: a proposal waits in your Action queue until you approve it.
      </p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {created && (
        <section className="panel" aria-labelledby="new-key-heading">
          <h2 id="new-key-heading">Copy your key now</h2>
          <p>This is the only time it is shown. Keepwell stores a hash, so it can&apos;t be shown again.</p>
          <p>
            <code>{created.token}</code>
          </p>
          <p>
            {url ? "Add it to Claude Code with:" : "Add it to Claude Code (use your Keepwell API address):"}
          </p>
          <p>
            <code>{claudeAddCommand(url ?? "https://<your-api-address>/mcp/merchant", created.token)}</code>
          </p>
          <button className="secondary" onClick={() => setCreated(null)}>
            I have copied it
          </button>
        </section>
      )}

      <form className="panel" onSubmit={(event) => void create(event)} aria-labelledby="create-key-heading">
        <h2 id="create-key-heading">Create a key</h2>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            placeholder="Claude Desktop"
          />
        </label>
        <fieldset>
          <legend>What it may do</legend>
          {SCOPE_ORDER.map((scope) => (
            <label key={scope} className="scope-option">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => setScopes(toggleScope(scopes, scope))}
              />
              <span>
                <strong>{SCOPE_INFO[scope].label}</strong>: {SCOPE_INFO[scope].detail}
              </span>
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={busy || name.trim() === "" || scopes.length === 0}>
          Create key
        </button>
      </form>

      <h2>Your keys</h2>
      {keys === null && !error && <p role="status">Loading…</p>}
      {keys && (
        <div className="table-wrap">
          <table>
            <caption>Active API keys</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={5}>No keys yet.</td>
                </tr>
              ) : (
                keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <code>{key.prefix}…</code>
                    </td>
                    <td>{key.scopes.map((scope) => SCOPE_INFO[scope].label).join(", ")}</td>
                    <td>{when(key.lastUsedAt)}</td>
                    <td>
                      {confirming === key.id ? (
                        <>
                          <button disabled={busy} onClick={() => void revoke(key.id)}>
                            Confirm revoke
                          </button>{" "}
                          <button className="secondary" onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="secondary" onClick={() => setConfirming(key.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
