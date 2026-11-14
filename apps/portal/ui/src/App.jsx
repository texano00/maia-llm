import { useCallback, useEffect, useMemo, useState } from "react";
import {
  catalogueStatus,
  changeCapability,
  createUseCase,
  currentSession,
  deleteUseCase,
  forceRefresh,
  listAccounts,
  listAudit,
  listInstallations,
  listUseCases,
  reorderUseCases,
  revokeInstallation,
  signIn,
  signOut,
  updateUseCase,
  uploadImage
} from "./api.js";

const TABS = [
  { id: "operations", label: "Operations" },
  { id: "accounts", label: "Accounts" },
  { id: "use-cases", label: "Use cases" },
  { id: "installations", label: "Installations" },
  { id: "audit", label: "Audit" }
];

export default function App() {
  const [session, setSession] = useState(undefined);
  const [tab, setTab] = useState("operations");
  const [error, setError] = useState(null);

  useEffect(() => {
    currentSession()
      .then(setSession)
      .catch((failure) => setError(failure.message));
  }, []);

  if (error) {
    return (
      <div className="shell">
        <div className="alert">{error}</div>
      </div>
    );
  }

  if (session === undefined) {
    return <div className="shell muted">Loading…</div>;
  }

  if (session === null) {
    return <SignIn onSignedIn={setSession} />;
  }

  return (
    <div className="shell">
      <header className="brand">
        <h1>Maia LLM backoffice</h1>
        <span>{session.email}</span>
        <span style={{ marginLeft: "auto" }}>
          <button
            className="ghost"
            onClick={async () => {
              await signOut();
              setSession(null);
            }}
          >
            Sign out
          </button>
        </span>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className="tab"
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === "operations" ? <Operations /> : null}
      {tab === "accounts" ? <Accounts /> : null}
      {tab === "use-cases" ? <UseCases /> : null}
      {tab === "installations" ? <Installations /> : null}
      {tab === "audit" ? <Audit /> : null}
    </div>
  );
}

/**
 * Who is using the product, and what they may see. Capabilities are granted here
 * and enforced in the product, so a change applies on its next request.
 */
function Accounts() {
  const [page, setPage] = useState(null);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async (query) => {
    setError(null);
    try {
      setPage(await listAccounts({ query }));
    } catch (failure) {
      setError(
        failure.code === "unavailable"
          ? "The product cannot be reached right now. Check MAIA_INTERNAL_TOKEN and MAIA_WEB_INTERNAL_URL."
          : failure.message
      );
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  async function toggle(account, capability, has) {
    if (has && capability === "operator") {
      const confirmed = window.confirm(
        `Revoke operator from ${account.email}? Their developer settings disappear on the next request.`
      );
      if (!confirmed) {
        return;
      }
    }

    setBusyId(account.id);
    setError(null);
    setNotice(null);
    try {
      await changeCapability(account.id, has ? { revoke: capability } : { grant: capability });
      setNotice(`${capability} ${has ? "revoked from" : "granted to"} ${account.email}.`);
      await load(search);
    } catch (failure) {
      setError(
        failure.code === "last-operator"
          ? "That is the last operator. Grant somebody else first."
          : failure.message
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error ? <div className="alert">{error}</div> : null}
      {notice ? <div className="muted">{notice}</div> : null}

      <section className="card">
        <h2>Accounts</h2>
        <div className="row">
          <input
            type="search"
            placeholder="Search by address"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void load(search);
              }
            }}
          />
          <button className="ghost" onClick={() => void load(search)}>
            Search
          </button>
          <span className="muted">{page ? `${page.total} accounts` : ""}</span>
        </div>

        {page && page.accounts.length === 0 ? (
          <p className="muted">No account matches that address.</p>
        ) : null}

        {page && page.accounts.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Last seen</th>
                <th>Active runs</th>
                <th>Debug</th>
                <th>Operator</th>
              </tr>
            </thead>
            <tbody>
              {page.accounts.map((account) => {
                const hasDebug = account.capabilities.includes("debug");
                const hasOperator = account.capabilities.includes("operator");
                return (
                  <tr key={account.id}>
                    <td data-label="Account">{account.email}</td>
                    <td className="muted" data-label="Last seen">
                      {account.lastSeenAt ? new Date(account.lastSeenAt).toLocaleString() : "never"}
                    </td>
                    <td data-label="Active runs">{account.activeSessions}</td>
                    <td data-label="Debug">
                      <button
                        className="ghost"
                        disabled={busyId === account.id}
                        onClick={() => void toggle(account, "debug", hasDebug)}
                      >
                        {hasDebug ? "Revoke" : "Grant"}
                      </button>
                    </td>
                    <td data-label="Operator">
                      <button
                        className="ghost"
                        disabled={busyId === account.id}
                        onClick={() => void toggle(account, "operator", hasOperator)}
                      >
                        {hasOperator ? "Revoke" : "Grant"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card signin"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const session = await signIn(email, password);
          onSignedIn(session);
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Sign in</h2>
      {error ? <div className="alert">{error}</div> : null}
      <label>
        Email
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label style={{ marginTop: "0.75rem" }}>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

function Operations() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setStatus(await catalogueStatus());
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await forceRefresh();
      await load();
    } catch (failure) {
      setError(
        failure.code === "refresh_in_progress"
          ? "A refresh is already running. Wait for it to finish."
          : failure.message
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <div className="alert">{error}</div> : null}

      <section className="card">
        <h2>Catalogue snapshot</h2>
        <div className="row">
          <span className={status?.snapshot ? "pill ok" : "pill warn"}>
            {status?.snapshot ? `v${status.snapshot.version}` : "not built"}
          </span>
          {status?.snapshot ? (
            <span className="muted">
              {status.snapshot.modelCount} models · {status.snapshot.supportedCount} supported ·{" "}
              {status.ageMinutes} min old
            </span>
          ) : (
            <span className="muted">No snapshot has been published yet.</span>
          )}
          <span style={{ marginLeft: "auto" }}>
            <button onClick={refresh} disabled={busy}>
              {busy ? "Refreshing…" : "Force refresh"}
            </button>
          </span>
        </div>
      </section>

      <section className="card">
        <h2>Recent runs</h2>
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Trigger</th>
              <th>Outcome</th>
              <th>Models</th>
              <th>Failed</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {(status?.runs ?? []).map((run) => (
              <tr key={run.id}>
                <td data-label="Started">{new Date(run.startedAt).toLocaleString()}</td>
                <td data-label="Trigger">{run.trigger}</td>
                <td data-label="Outcome">
                  <span className={run.outcome === "success" ? "pill ok" : "pill danger"}>
                    {run.outcome}
                  </span>
                </td>
                <td data-label="Models">{run.models}</td>
                <td data-label="Failed">{run.failed}</td>
                <td className="muted" data-label="Error">{run.error ?? ""}</td>
              </tr>
            ))}
            {status && status.runs.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted" data-label="Runs">
                  No runs yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}

const emptyDraft = {
  id: null,
  title: "",
  description: "",
  modelsText: "",
  imageUrl: "",
  enabled: true,
  version: 0
};

function UseCases() {
  const [useCases, setUseCases] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setUseCases(await listUseCases());
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const models = useMemo(
    () =>
      draft.modelsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [draft.modelsText]
  );

  function edit(useCase) {
    setDraft({
      id: useCase.id,
      title: useCase.title,
      description: useCase.description,
      modelsText: useCase.models.map((model) => model.id).join("\n"),
      imageUrl: useCase.imageUrl ?? "",
      enabled: useCase.enabled,
      version: useCase.version
    });
    setNotice(null);
    setError(null);
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const payload = {
      title: draft.title,
      description: draft.description,
      models,
      imageUrl: draft.imageUrl || null,
      enabled: draft.enabled,
      ...(draft.id ? { version: draft.version } : {})
    };

    try {
      if (draft.id) {
        await updateUseCase(draft.id, payload);
        setNotice("Saved.");
      } else {
        await createUseCase(payload);
        setNotice("Created.");
      }
      setDraft(emptyDraft);
      await load();
    } catch (failure) {
      setError(
        failure.code === "conflict"
          ? "Someone else changed this use case. Reload it before saving."
          : failure.message
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(useCase) {
    if (!window.confirm(`Delete "${useCase.title}"?`)) {
      return;
    }
    await deleteUseCase(useCase.id);
    await load();
  }

  async function move(index, delta) {
    const next = [...useCases];
    const target = index + delta;
    if (target < 0 || target >= next.length) {
      return;
    }
    [next[index], next[target]] = [next[target], next[index]];
    setUseCases(next);
    await reorderUseCases(next.map((useCase) => useCase.id));
  }

  async function attachImage(file) {
    if (!file) {
      return;
    }
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const [meta, base64] = dataUrl.split(",");
    const contentType = meta.slice(meta.indexOf(":") + 1).split(";")[0];

    try {
      const { url } = await uploadImage(contentType, base64);
      setDraft((current) => ({ ...current, imageUrl: url }));
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  }

  return (
    <>
      {error ? <div className="alert">{error}</div> : null}
      {notice ? <div className="card muted">{notice}</div> : null}

      <div className="grid-2">
        <section className="card">
          <h2>Basic-mode use cases</h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Models</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {useCases.map((useCase, index) => (
                <tr key={useCase.id}>
                  <td data-label="Order">
                    <button className="ghost" onClick={() => move(index, -1)} aria-label="Move up">
                      ↑
                    </button>
                    <button className="ghost" onClick={() => move(index, 1)} aria-label="Move down">
                      ↓
                    </button>
                  </td>
                  <td data-label="Use case">
                    <strong>{useCase.title}</strong>
                    <div>
                      <span className={useCase.enabled ? "pill ok" : "pill warn"}>
                        {useCase.enabled ? "enabled" : "disabled"}
                      </span>{" "}
                      <span className="pill">v{useCase.version}</span>
                    </div>
                  </td>
                  <td data-label="Models">
                    <ul className="models">
                      {useCase.models.map((model) => (
                        <li key={model.id}>
                          {model.id}{" "}
                          {model.missing ? (
                            <span className="pill danger">missing</span>
                          ) : model.supported ? (
                            <span className="pill ok">{model.engine}</span>
                          ) : (
                            <span className="pill warn">unsupported</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="row" data-label="Actions">
                    <button className="ghost" onClick={() => edit(useCase)}>
                      Edit
                    </button>
                    <button className="danger" onClick={() => remove(useCase)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {useCases.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted" data-label="Use cases">
                    No use cases yet. Create the first one on the right.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <form className="card" onSubmit={save}>
          <h2>{draft.id ? "Edit use case" : "New use case"}</h2>

          <label>
            Title
            <input
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              minLength={3}
              maxLength={120}
              required
            />
          </label>

          <label style={{ marginTop: "0.7rem" }}>
            Description
            <textarea
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              minLength={10}
              maxLength={2000}
              required
            />
          </label>

          <label style={{ marginTop: "0.7rem" }}>
            Models, in preference order (one id per line)
            <textarea
              value={draft.modelsText}
              onChange={(event) => setDraft({ ...draft, modelsText: event.target.value })}
              placeholder={"Qwen/Qwen2.5-7B-Instruct\nhuihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF"}
              required
            />
          </label>
          <p className="muted">
            The desktop picks the first entry that the snapshot marks supported; unsupported
            entries stay here and are skipped, never silently dropped.
          </p>

          <label style={{ marginTop: "0.7rem" }}>
            Image (PNG, JPEG or WebP, max 2 MB)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => attachImage(event.target.files?.[0])}
            />
          </label>
          {draft.imageUrl ? <img className="preview" src={draft.imageUrl} alt="" /> : null}

          <label className="row" style={{ marginTop: "0.7rem" }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              style={{ width: "auto" }}
            />
            Enabled
          </label>

          <div className="row" style={{ marginTop: "1rem" }}>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : draft.id ? "Save changes" : "Create"}
            </button>
            {draft.id ? (
              <button type="button" className="ghost" onClick={() => setDraft(emptyDraft)}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </>
  );
}

function Installations() {
  const [installations, setInstallations] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setInstallations(await listInstallations());
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card">
      {error ? <div className="alert">{error}</div> : null}
      <h2>Installations</h2>
      <table>
        <thead>
          <tr>
            <th>Installation</th>
            <th>State</th>
            <th>App</th>
            <th>Last contact</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {installations.map((installation) => (
            <tr key={installation.id}>
              <td className="models" data-label="Installation">{installation.installId}</td>
              <td data-label="State">
                <span className={installation.state === "active" ? "pill ok" : "pill danger"}>
                  {installation.state}
                </span>
              </td>
              <td className="muted" data-label="App">
                {installation.appVersion ?? "?"} · {installation.platform ?? "?"}
              </td>
              <td data-label="Last contact">{new Date(installation.lastSeenAt).toLocaleString()}</td>
              <td data-label="Action">
                {installation.state === "active" ? (
                  <button
                    className="danger"
                    onClick={async () => {
                      await revokeInstallation(installation.id);
                      await load();
                    }}
                  >
                    Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {installations.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted" data-label="Installations">
                No installation has enrolled yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function Audit() {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    listAudit()
      .then(setEntries)
      .catch((failure) => setError(failure.message));
  }, []);

  return (
    <section className="card">
      {error ? <div className="alert">{error}</div> : null}
      <h2>Audit trail</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.occurredAt}-${index}`}>
              <td data-label="When">{new Date(entry.occurredAt).toLocaleString()}</td>
              <td className="muted" data-label="Actor">
                {entry.actorKind}
                {entry.actorId ? `:${entry.actorId.slice(0, 8)}` : ""}
              </td>
              <td data-label="Action">{entry.action}</td>
              <td className="models" data-label="Target">
                {entry.target ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
