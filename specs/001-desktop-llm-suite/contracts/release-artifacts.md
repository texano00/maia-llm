# Contract: Release Artifacts and Update Feed

**Feature**: `001-desktop-llm-suite` | **Version**: 1.0.0

GitHub Actions builds every artifact, and GitHub Releases distributes them. The desktop app's updater consumes the same release feed that users download from. This contract defines names, hashes, signatures, provenance, and failure semantics.

## Channels and Versioning

| Channel | Tag pattern | GitHub Release state | Who receives it |
|---------|-------------|----------------------|-----------------|
| `stable` | `vMAJOR.MINOR.PATCH` | Published, marked latest | All default installations |
| `beta` | `vMAJOR.MINOR.PATCH-beta.N` | Published as prerelease | Installations that opted into beta |

- The tag must equal the version in the root and app `package.json` files; the release workflow fails otherwise.
- A published version is immutable: assets are never overwritten or rebuilt. Rollback promotes an earlier release or removes the bad one from the feed.
- `min_supported_version` is advisory in v1 and may only be raised when a backend schema or security fix requires it.

## Release Assets

| Asset | Required | Notes |
|-------|----------|-------|
| `MaiaLLM-Setup-{version}-x64.exe` | Yes | Authenticode-signed NSIS installer |
| `MaiaLLM-Setup-{version}-x64.exe.blockmap` | Yes | Differential update metadata |
| `MaiaLLM-{version}-x64.msi` | Optional | Enterprise MSI, also signed |
| `latest.yml` | Yes for stable | electron-updater feed |
| `latest-beta.yml` | Yes for beta | Separate feed for prereleases |
| `release-manifest.json` | Yes | Machine-readable release record |
| `SHA256SUMS.txt` | Yes | Human-verifiable checksums |
| `maia-llm-{version}-sbom.cdx.json` | Yes | CycloneDX SBOM |
| `MaiaLLM-Setup-{version}-x64.exe.sig` | Optional | Detached signature for third-party verification |

Future macOS and Linux assets (`*.dmg`, `*.AppImage`, `*.deb`, `*.rpm`) may be attached only after those platforms are declared supported; until then they are build dry-runs and are not published.

## Update Feed (`latest.yml`)

```yaml
version: 1.2.3
files:
  - url: MaiaLLM-Setup-1.2.3-x64.exe
    sha512: <base64-encoded SHA-512>
    size: 123456789
  - url: MaiaLLM-1.2.3-x64.msi
    sha512: <base64-encoded SHA-512>
    size: 234567890
path: MaiaLLM-Setup-1.2.3-x64.exe
sha512: <base64-encoded SHA-512>
releaseDate: '2026-11-02T10:00:00.000Z'
```

Rules:
- `version` matches the tag and `release-manifest.json`.
- Every file listed in `files` exists in the same GitHub Release and its SHA-512 matches the uploaded bytes.
- `latest.yml` is generated only after all artifacts are uploaded and verified.
- `latest-beta.yml` is never referenced by stable installations.
- The updater verifies the signature of the downloaded installer before launching it and refuses unsigned or mismatched binaries.

## Release Manifest (`release-manifest.json`)

```json
{
  "schema_version": 1,
  "version": "1.2.3",
  "channel": "stable",
  "released_at": "2026-11-02T10:00:00Z",
  "min_supported_version": "1.0.0",
  "source": {
    "provider": "github",
    "owner": "texano00",
    "repo": "maia-llm",
    "tag": "v1.2.3",
    "release_url": "https://github.com/texano00/maia-llm/releases/tag/v1.2.3"
  },
  "artifacts": [
    {
      "platform": "windows-x64",
      "kind": "nsis",
      "file": "MaiaLLM-Setup-1.2.3-x64.exe",
      "size_bytes": 123456789,
      "sha256": "<64 lowercase hex>",
      "sha512": "<base64>",
      "signed": true,
      "sbom": "maia-llm-1.2.3-sbom.cdx.json"
    }
  ],
  "telemetry_schema_version": 1
}
```

Validation:
- `schema_version` is `1`.
- `version`, `tag`, and asset names agree.
- `sha256` is 64 lowercase hex characters; `sha512` is valid base64.
- At least one `windows-x64` artifact is present and `signed` is `true`.
- `released_at` is UTC ISO-8601.

The publish job writes this manifest and appends its SHA-256 to the release notes.

## Build Provenance and Signing

- The release workflow requests `id-token: write` and uses GitHub artifact attestations for the installer(s) and the SBOM.
- The Windows installer is signed with Authenticode using a certificate stored only in the protected `release` environment.
- Verification performed by the publish job before publication:
  1. Authenticode signature check (`signtool verify /pa`).
  2. SHA-256 recomputation of every asset after download from the draft release.
  3. `latest.yml` SHA-512 consistency with the actual files.
  4. Release manifest consistency with the tag, package metadata, and assets.
- Any failure aborts publication and leaves the GitHub Release as a draft or deletes it.

## Workflow Contract (`release.yml`)

| Input / Output | Definition |
|----------------|------------|
| Trigger | Protected tag `v*` or approved `workflow_dispatch` |
| Inputs | `version` (semver), `channel` (`stable` \| `beta`), `dry_run` (boolean) |
| Preconditions | Tag equals version; commit is on `main`; `release` environment approved |
| Permissions | Default `contents: read`; publish job `contents: write`, `id-token: write`, `packages: write` |
| Outputs | Signed desktop assets and manifest in a GitHub Release; telemetry image digest in GHCR |
| Dry run | Runs all builds, signing checks, hashing, and SBOM generation; uploads CI artifacts; publishes nothing |
| Failure | Non-zero exit, no public release, failed logs retained for 14 days |

The workflow must never receive provider API keys (Hugging Face, vast.ai, S3) and must run all E2E tests with `MAIA_PROVIDER_MODE=mock`.

## Telemetry Image

- Image: `ghcr.io/texano00/maia-llm-telemetry@sha256:<digest>`.
- Tags such as `1.2.3` and `latest` are conveniences; deployments must reference the digest.
- The image is built on `ubuntu-24.04`, scanned for high-severity vulnerabilities, and attested with provenance.
- Deployment to production is a separate approved operations step; the release workflow only publishes the image.

## Verification Commands

```bash
gh release download v1.2.3 --repo texano00/maia-llm --dir release-assets
sha256sum -c release-assets/SHA256SUMS.txt
signtool verify /pa /v release-assets/MaiaLLM-Setup-1.2.3-x64.exe
gh attestation verify release-assets/MaiaLLM-Setup-1.2.3-x64.exe --repo texano00/maia-llm
```

## Rollback and Revocation

- To roll back, publish the previous release as latest and mark the faulty release as prerelease or remove it from the feed; never rebuild old assets.
- If a signing key is compromised, revoke the certificate, publish a security advisory, and rotate the certificate in the protected environment before the next release.
- If an asset is found to be corrupted, delete the release and re-run the workflow for the same tag only after confirming the commit and signing inputs; the replacement must use a new patch version if the original was already distributed.
