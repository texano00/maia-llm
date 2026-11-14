# Contract — Catalogue selection and runnability

**Feature**: 009-live-gpu-account-detail | **Date**: 2026-11-14

How a repository enters the published catalogue, how its runnability is decided, and
what the product tells the client so the "Only models I can run" filter and the start
action cannot disagree.

## Selection (snapshot build)

The publisher (`apps/portal/src/services/catalogue/snapshot-service.ts`) includes the
union of three sources:

| Source | Rule |
|---|---|
| `required` | `MAIA_CATALOGUE_REQUIRED` — comma or whitespace separated `owner/name` ids, case-insensitive, ignored if malformed. Always included, even when not runnable. |
| `popularity` | Per pipeline tag (`text-generation`, `image-text-to-text`, `text-to-image`), the first `MAIA_CATALOGUE_LIMIT` entries ordered by downloads. |
| `ggufSibling` | For each included `owner/base`, the repositories `owner/base-GGUF`, `owner/base.gguf` and `owner/base-GGUF-*`, when they exist. |

Rules:

- Duplicates collapse by id; a required entry wins over a popularity entry.
- A required repository that cannot be fetched is listed by name in the run outcome,
  and the pass still publishes (FR-035).
- The whole pass is still single-flight, and a partial result never publishes
  (FR-034).
- Expected size: up to roughly twice today's count. Above that, the limit is the knob,
  not the window.

## Runnability verdict

Computed per entry when the snapshot is built:

1. **Engine** — GGUF weights anywhere in the repository ⇒ `llamacpp`; safetensors with
   a root `config.json` ⇒ `vllm`; both ⇒ `vllm`; neither ⇒ `null`.
   Weight files are searched at the root first and then in the shallowest
   quantisation folder, so a repository whose quants live in `Q4_K_M/` is no longer
   reported as empty (FR-033).
2. **Loadable** — not a package library (`diffusers`, `peft`, `timm`,
   `sentence-transformers`), and weights present as above.
3. **Chat template** — the tokenizer configuration declares one, or the repository is
   a GGUF whose metadata does (GGUF carries its own template).

`supported = engine !== null && loadable && chatTemplate`, and `supportedReason`
carries the first failing reason in a sentence the person can act on. A repository
that is included because it is required but fails one of these is still **listed**
with that reason (FR-032).

## Per-person readiness (product side)

The catalogue payload is global; readiness is personal and present-tense. The product
derives it when rendering:

```
ready(model, credentialStatus) =
  model.supported
  && (!model.gated || credentialStatus.huggingface === true)
```

- `gated` — the repository requires an authenticated request (`gated` on the Hub
  entry).
- The same helper feeds the "Only models I can run" filter and the start action, so a
  listed model cannot be refused on start and a hidden model cannot be startable
  (FR-036/FR-037).
- A model excluded only because of a missing credential says so in the catalogue, and
  the catalogue states how many models the filter hides (FR-038/FR-039).
- The filter's state lives in `account_settings.value_json` as
  `catalogueSupportedOnly`, so it survives reload and navigation (FR-040).

## What does not change

- The client never calls the model hub directly; it renders the snapshot the backend
  publishes.
- Snapshot versions stay immutable and the last 30 are kept.
- `GET /v1/config/catalogue` keeps its ETag/304 behaviour; the payload gains no new
  top-level field, so older clients keep working.
