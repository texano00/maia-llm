# Contract: Hugging Face Catalogue Adapter

**Feature**: `001-desktop-llm-suite` | **Version**: 1.0.0

The desktop app reads the public Hugging Face Hub API. It never writes to the Hub. A user token is optional and is required only for gated or private models.

## Base and Authentication

- Base URL: `https://huggingface.co`
- Optional header: `Authorization: Bearer <token>` from the OS credential vault.
- Client identifies itself with a product user agent and respects `429` / `Retry-After`.

## Model Search

`GET /api/models`

| Query parameter | Use |
|-----------------|-----|
| `search` | Free-text query |
| `author` | Publisher filter |
| `filter` | `text-generation` (and additional task filters exposed in advanced search) |
| `sort` | `downloads`, `likes`, or `lastModified` |
| `direction` | `-1` for descending |
| `limit` | Page size, capped at 100 |
| `full` | `true` to receive metadata needed for filters |
| pagination | Follow the Hub's documented cursor/`Link` mechanism; the adapter hides it behind `nextCursor` |

Response mapping (subset of Hub fields):

| Hub field | Local field |
|-----------|-------------|
| `id` | `catalogue_models.id` |
| `author` | `author` |
| `modelId` | `name` |
| `cardData.license` or `tags` license entry | `license` |
| `pipeline_tag` | `pipeline_tag` |
| `safetensors.total` or `cardData.parameters` | `parameter_count` |
| `config.max_position_embeddings` when present | `context_window` |
| `downloads`, `likes` | popularity |
| `gated` | `gated` (`false` → `none`, `"auto"`, `"manual"`) |
| `lastModified` | `last_modified_at` |
| `tags` | `tags_json` |

## Model Detail

`GET /api/models/{repo_id}`

Used to populate license terms, model card summary, architectures, and safety metadata. Missing license is displayed as "license not declared" and blocks backup until the user acknowledges the unknown license.

## Artifact Listing

`GET /api/models/{repo_id}/tree/{revision}?recursive=true&expand=true`

Mapping:

| Hub field | Local field |
|-----------|-------------|
| `path` | `model_artifacts.path` |
| `size` | `size_bytes` |
| `lfs.oid` | `sha256` (LFS SHA-256) |
| `type == "file"` | included |
| file extension | `format` (`safetensors`, `gguf`, `other`) |
| filename pattern (`Q4_K_M`, `AWQ`, `GPTQ`) | `quantization` |

Compute `digest` for `/api/tags` from the revision commit SHA or the Hub-provided model digest.

## File Resolution and Download

- Resolve URL: `https://huggingface.co/{repo_id}/resolve/{revision}/{path}`
- Use `HEAD` for existence and size checks; use HTTP `Range` for resumable downloads.
- Treat `302` redirects to CDN URLs as expected and re-apply auth only to the Hub origin.
- Verify LFS artifacts against `lfs.oid` after download.

## Gated and Private Models

- `401` or `403` with a gated signal → surface "access required" and link to the model page.
- Store license acceptance locally per model and revision family (`catalogue_acceptances` is represented in preferences/acceptance data).
- Never store the HF token in catalogue cache, logs, error messages, or telemetry.

## Caching and Offline Behavior

| Concern | Rule |
|---------|------|
| Search cache TTL | 15 minutes |
| Conditional requests | Send `If-None-Match` with the stored ETag |
| Offline | Serve the last successful snapshot, flagged `stale: true` |
| Refresh | Manual refresh bypasses TTL but not rate limits |
| Failure | Keep the previous snapshot and show a non-blocking error |
| Pagination | Cache pages by normalised query plus cursor |

Precedence: fresh network result → ETag-validated cache → stale snapshot.

## Error Mapping

| Condition | Adapter error | UI behavior |
|-----------|---------------|-------------|
| `401` / `403` | `NOT_AUTHENTICATED` or `GATED` | Prompt for token or license acceptance |
| `404` | `NOT_FOUND` | Mark model unavailable |
| `429` | `RATE_LIMITED` | Backoff with `Retry-After`, keep cache |
| `5xx` | `PROVIDER_UNAVAILABLE` | Retry with backoff, show stale cache |
| Timeout | `PROVIDER_UNAVAILABLE` | Retry once, then stale cache |

## Performance Requirements

- Cached search must return within 1 second for 10,000 models (SC-006).
- Artifact listings are cached by `(repo_id, revision)` for 24 hours.
- Metadata requests are deduplicated in-flight to avoid parallel duplicate calls.

## Privacy

Only public catalogue metadata leaves the device. Search queries are not part of telemetry; the telemetry event records only result counts and durations.
