# Research: Light-first appearance and account-held configuration

**Feature**: 006-theme-and-user-config | **Date**: 2026-11-14

Each decision resolves a technical unknown from the plan or a requirement in
`spec.md`. Alternatives are listed with the reason they lost.

## D1 — Theming mechanism

**Decision**: One semantic token layer in `theme.css`. `:root` defaults to the
light palette; `:root[data-theme="dark"]` overrides it. The ~55 colour literals
now in 326 declarations are replaced by ~20 variables (`--surface-0/1/2`,
`--surface-raised`, `--text`, `--text-muted`, `--text-faint`, `--border`,
`--border-strong`, `--accent`, `--accent-soft`, `--accent-strong`, `--success`,
`--warning`, `--danger`, `--scrim`, `--shadow`, plus the existing gradient
stops). No selector, spacing or layout changes are made in the same pass.

**Rationale**: An attribute switch is the cheapest way to satisfy "switch the
whole product", works identically for the signed-out access page and the app, and
keeps one stylesheet. Tokens also make the contrast check (D8) a static analysis
of named pairs rather than a browser measurement.

**Alternatives considered**:
- CSS `light-dark()` with `color-scheme`: elegant, but it ties the palette to the
  `color-scheme` property, has no place for a stored per-account choice before
  paint, and cannot be asserted statically as easily.
- Two stylesheets swapped at runtime: doubles the CSS, and a swap mid-paint is
  exactly the flash the spec forbids.
- A styling library or CSS-in-JS: a new dependency for a job one attribute and
  one variable block already do.

## D2 — No flash before the first paint

**Decision**: A short inline script in `src/renderer/index.html` runs before the
bundle and sets `document.documentElement.dataset.theme` from, in order:
the `maia_appearance` cookie, then `localStorage["maia:appearance"]`, then
`"light"`. The cookie is **not** HttpOnly because the script must read it; it
carries only `light`/`dark`, `Path=/`, `SameSite=Lax`, one-year lifetime, and
`Secure` whenever session cookies are secure.

**Rationale**: The account's choice is known to the server, not to a new browser.
Without a server-readable mirror, a person who chose dark would see a light
first paint on every new device — precisely SC-001/SC-002. The cookie is the only
value small and non-sensitive enough to expose to script.

**Alternatives considered**:
- `localStorage` only: works on the same browser, fails cross-device, which the
  spec requires (US1 scenario 4).
- Server-side rendering of the attribute: the renderer is a static bundle served
  by a file server; adding templating for one attribute is disproportionate.
- Blocking the paint until `/rpc` answers: adds a round trip to every load and
  still flashes when the network is slow.

## D3 — Where the appearance lives

**Decision**: `appSettingsSchema.appearance` (`"light" | "dark"`, default
`"light"`) stored in `account_settings`. The cookie is a cache written on every
`auth.state` and on `settings.update` that changes it. The signed-out access page
uses only the local fallback.

**Rationale**: The spec makes the account the owner of configuration; a second
source of truth (a renderer-only setting) would immediately drift. Deriving the
cookie from the stored value keeps them consistent by construction.

**Alternatives considered**: a separate `appearance` column (a table change for
one enum), or a browser-only preference (contradicts US2).

## D4 — Configuration document

**Decision**: A versioned JSON document (`version: 1`) built from
`appSettingsSchema` plus a credential *presence* list
(`provider`, `saved`, `status`, `lastVerifiedAt`). `config.get` returns it,
`config.export` returns the same object for the client to save, `config.import`
validates it with Zod, applies only known keys, reports skipped entries, and never
touches credentials.

**Rationale**: One shape for "retrieve" and "export" means the person's own
tooling and the UI see identical content (FR-006), and a later storage migration
can be validated by re-importing a document.

**Alternatives considered**:
- Exporting the raw `account_settings` blob: leaks internal shape, no version,
  no guarantee about secrets.
- A file format per section: more code, and no single "everything" answer.

## D5 — Build information

**Decision**: `app.info` gains `version` (release version, from
`MAIA_APP_VERSION` or `apps/web/package.json`) and loses `electron` and `chrome`.
The panel renders exactly two rows: Channel, Version. When the version cannot be
read, the panel says "unknown" in words.

**Rationale**: The two unused fields only existed to be rendered as `n/a`, which
the spec calls out. Removing them makes "nothing else" true at the contract level,
not just in the view.

**Alternatives considered**: keeping them optional and hiding them in the UI
(leaves a trap for the next consumer).

## D6 — Reset scopes

**Decision**: `config.reset` takes `{ scope: "all" | "appearance" | "catalogue" |
"chat" | "gpu" | "telemetry" | "onboarding" | "credentials", confirm: true }`.
`credentials` deletes stored provider secrets; `all` resets settings and deletes
secrets only when `credentials` is included or the caller asks for `all` — the UI
warns before that, per the spec's edge case.

**Rationale**: People think in sections, not fields. Naming the scopes in the
contract keeps the UI and the tests aligned with one vocabulary.

**Alternatives considered**: a field list (error-prone, and the caller has to know
defaults), or "delete everything" only (too blunt for a single wrong filter).

## D7 — Moving browser preferences without breaking existing users

**Decision**: Add `catalogueMode`, `studentMode`, `historyOpen`,
`lastConversationId` and `acknowledgedFailureIds` to `appSettingsSchema` with the
current renderer defaults. On first sign-in after the change, a one-time
carry-over copies values found under the existing `maia:*` keys when the account
still holds defaults, then sets `localStorage["maia:prefs-migrated"] = "1"`.
After that, the renderer never reads or writes those keys.

**Rationale**: Zod defaults fill the new fields for every existing row, so there
is no schema migration; the carry-over preserves what people already chose. The
marker keeps it to one run so a later reset is not undone by stale browser values.

**Alternatives considered**: a database migration that guesses values (it cannot
see the browser), or dropping the old values silently (a regression for anyone who
had set student mode).

## D8 — Proving the light theme is usable

**Decision**: `apps/web/tests/unit/theme-contrast.test.ts` parses `theme.css`,
extracts the documented text/background token pairs for both palettes, and asserts
WCAG AA (≥ 4.5:1 for body text, ≥ 3:1 for borders and large text). It fails the
build if a palette edit drops below the threshold.

**Rationale**: "Light by default" is only a win if it is readable; a colour-only
change is otherwise unverifiable in review. Computing the ratio from the token
values needs no browser and no new dependency.

**Alternatives considered**: a visual screenshot diff (no automated threshold),
or leaving contrast to manual review (the status quo that produced a
low-contrast dark palette in places).

## D9 — Keeping the storage layer replaceable

**Decision**: All configuration reads and writes go through
`SettingsStore`/`CredentialStore` with the existing `?`-placeholder SQL; the new
`services/config/document.ts` is pure (document in, document out) and contains no
SQL. No new table is introduced.

**Rationale**: The user intends to move to a network database later. Keeping the
document logic pure means the move replaces adapters, not behaviour, and the
versioned export remains the migration path.

**Alternatives considered**: a dedicated `user_configurations` table with one
column per setting (a schema change per new preference, and it centralises SQL in
a place that would need rewriting later).
