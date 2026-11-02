# Contract: S3 Model Backup Manifest and Layout

**Feature**: `001-desktop-llm-suite` | **Version**: 1.0.0

Backups go to the user's own S3-compatible bucket. The desktop never proxies backup data through the telemetry backend.

## Object Layout

```text
{prefix}/models/{author}/{name}/{revision}/
├── manifest.json
└── files/
    └── {original/relative/path}
```

Rules:
- `prefix` is user-supplied, has no leading `/`, no `..` segments, and is limited to 1024 characters.
- Each file keeps its original repository-relative path under `files/`.
- Revisions are commit SHAs where possible; branch names are resolved to a SHA before upload.
- The manifest is written last, so its presence means the upload completed.

## Manifest Schema

```json
{
  "manifest_version": 1,
  "model_id": "meta-llama/Llama-3.2-3B-Instruct",
  "revision": "0e9e39f249a16976918f6564b8830bc894c89659",
  "created_at": "2026-11-02T10:30:00Z",
  "created_by_app_version": "1.0.0",
  "source": "huggingface",
  "license": "llama3.2",
  "source_url": "https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct",
  "total_bytes": 6422528000,
  "artifact_count": 12,
  "files": [
    {
      "path": "model-00001-of-00002.safetensors",
      "size_bytes": 3211264000,
      "sha256": "9f2c1d...",
      "content_type": "application/octet-stream",
      "lfs": true
    }
  ]
}
```

Validation:
- `manifest_version` must be `1`.
- `model_id` matches `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`.
- `revision` is a 40-character hex SHA or a documented branch name resolved before writing.
- `sha256` is 64 lowercase hex characters.
- `total_bytes` equals the sum of `files[].size_bytes`.
- Paths contain no absolute prefix, no `..`, no backslashes, and no control characters.

## Upload Protocol

| Parameter | Value |
|-----------|-------|
| Multipart part size | 16–64 MiB, chosen from file size |
| Concurrency | 4–8 parts |
| Checksums | SHA-256 per part where supported, otherwise CRC32C |
| Resume | Persist `upload_id` and completed parts in `backup_artifacts` / local metadata |
| Encryption | SSE-S3 by default; SSE-KMS when the user configures a key |
| Timeouts | 30 s connect, 120 s per part, exponential retry |
| Retry policy | 5 attempts with jitter on 5xx, 408, 429, and network errors |

Workflow:
1. Validate credentials with a scoped `HeadBucket` and a test object under the prefix.
2. List the model tree and build the manifest locally.
3. Create multipart uploads per file; upload parts concurrently.
4. Resume by listing multipart uploads and uploaded parts, skipping verified parts.
5. Complete multipart uploads and verify returned checksums.
6. Upload `manifest.json` last.
7. Record `backup_records.status = completed` and `verified_at`.

## Verification

- Compare every stored object's size and checksum with the manifest.
- Prefer provider-side `ChecksumSHA256`; otherwise download and hash a sampled set, or fully re-hash on user request.
- A single missing or mismatched artifact marks the backup `broken` and names the failing paths.
- Verification is idempotent and does not upload.

## Restore Protocol

1. Fetch and validate `manifest.json`.
2. Check local free space against `total_bytes`.
3. Download files to a staging directory with `Range` resume.
4. Verify each file's SHA-256 against the manifest.
5. Atomically move the verified set into the local model cache and register it as a runnable model with `source = backup`.
6. Resolve the revision from the manifest, never from the Hub, so restoration works when the model is gone.

## License and Entitlement

- Gated models require verified Hub entitlement before the first upload.
- The manifest records the license string; the UI warns when redistribution is restricted.
- The backup tool never strips or alters license files.

## Error Mapping

| Condition | Code | Behavior |
|-----------|------|----------|
| Invalid credentials | `STORAGE_AUTH_FAILED` | Stop before any upload; link settings |
| Bucket missing or access denied | `STORAGE_AUTH_FAILED` | Show bucket and required permissions |
| Local disk full | `INSUFFICIENT_DISK` | Abort with required/available space |
| Network interruption | `NETWORK` | Pause, resume from verified parts |
| Checksum mismatch | `BACKUP_VERIFY_FAILED` | Mark broken, list artifacts, offer re-upload |
| Bucket deleted or renamed | `BROKEN` | Flag record, offer relink or re-upload |
| `5xx` / throttling | `RETRYABLE` | Backoff with jitter |

## Security

- Credentials are read from the OS vault per operation and never persisted in the manifest or object metadata.
- Object keys are sanitized to prevent prefix escape.
- Backups contain model files only; no conversations, prompts, credentials, or session data.
- Deleting a local backup record never deletes objects in the user's bucket; the UI states this explicitly.
