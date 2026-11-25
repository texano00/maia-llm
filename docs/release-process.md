# Release process

Two images, one tag. A release is a deployment: GitHub Actions builds
`ghcr.io/texano00/maia-llm-web` (the product) and `ghcr.io/texano00/maia-llm` (the
portal) on every merge to `main`, tags them with the root `package.json` version
plus `sha-<12>`, and moves `latest`. Watchtower polls `latest` on the servers.

## Version

1. Bump every workspace with one command:
   `npm run version:bump -- patch` (or `minor`, or an explicit `0.13.0`). It
   updates the root, both apps and both packages together, and keeps
   `package-lock.json` in step without creating a git tag.
2. `images.yml` starts with a **`version-guard` job** that runs before anything is
   built. It fails the workflow when the three manifests disagree, or when either
   image already has `<version>` in the registry. No `sha-`-only publish happens:
   a merge that forgot the bump is blocked and tells you to run the command above.
3. The version tag is immutable: if a concurrent run publishes the same version
   first, the `Tags` step also fails rather than overwriting it.
4. `MAIA_APP_VERSION` overrides the version a running container reports, for the
   rare case where an image must be told its tag explicitly.

Which version is running:

| Surface | Where it comes from |
| --- | --- |
| Product | build-information panel (`app.info.version`), `GET /health` → `version` |
| Backoffice | header readout: `GET /admin-api/version` → `portal` and `product` (the latter read from the product's `/health`, `null` when unreachable) |

## Checklist for a release wave

1. `npm run version:bump -- patch` (or `minor` / an explicit version), then
   commit the changed manifests and lockfile.
2. `npm run lint`, `npm run typecheck`,
   `npx vitest run apps/web/tests apps/portal/tests`, `npm run build`,
   `npm run -w @maia/portal build:admin` — all green.
3. Merge to `main` and watch `images.yml` publish `<version>` and `sha-<12>` for
   both images. If `version-guard` fails, the bump was missed: run the bump
   command, commit and push again — nothing was built.
4. Confirm the deployed containers report the new version: the backoffice header
   shows `portal <x> · product <y> (live GPUs)`, and `GET /health` on the product
   answers the same `y`.
5. If the catalogue changed, force a snapshot refresh from the backoffice
   (Operations) instead of waiting for the six-hourly pass, then check that the
   expected models are listed.
6. Roll back by pinning `MAIA_IMAGE_TAG` to the previous `sha-<12>` in `infra/.env`
   and recreating both services. Never move a published version tag to do it.

## What is not part of a release

- No installer, no signed binary, no update feed: the product is served.
- No desktop workflows. `web-ci.yml`, `portal-ci.yml` and `images.yml` are the
  whole pipeline.
