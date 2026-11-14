# Release process

Two images, one tag. A release is a deployment: GitHub Actions builds
`ghcr.io/texano00/maia-llm-web` (the product) and `ghcr.io/texano00/maia-llm` (the
portal) on every merge to `main`, tags them with the root `package.json` version
plus `sha-<12>`, and moves `latest`. Watchtower polls `latest` on the servers.

## Version

1. Bump `version` in `package.json` and `apps/web/package.json` (they must match),
   and `apps/portal/package.json` when the backoffice changed
   (`npm install --package-lock-only --ignore-scripts` keeps the lock in step).
2. The version tag is meant to be immutable. `images.yml` checks the registry
   first: if `<version>` already exists it publishes only `sha-<12>` and warns in
   the step summary. A warning therefore means "you forgot to bump", and it is the
   reason the release notes should never point at a tag that moved.
3. `MAIA_APP_VERSION` overrides the version a running container reports, for the
   rare case where an image must be told its tag explicitly.

Which version is running:

| Surface | Where it comes from |
| --- | --- |
| Product | build-information panel (`app.info.version`), `GET /health` → `version` |
| Backoffice | header readout: `GET /admin-api/version` → `portal` and `product` (the latter read from the product's `/health`, `null` when unreachable) |

## Checklist for a release wave

1. `npm run lint`, `npm run typecheck`,
   `npx vitest run apps/web/tests apps/portal/tests`, `npm run build`,
   `npm run -w @maia/portal build:admin` — all green.
2. Merge to `main` and watch `images.yml` publish `<version>` and `sha-<12>` for
   both images.
3. Confirm the deployed containers report the new version: the backoffice header
   shows `portal <x> · product <y> (live GPUs)`, and `GET /health` on the product
   answers the same `y`.
4. If the catalogue changed, force a snapshot refresh from the backoffice
   (Operations) instead of waiting for the six-hourly pass, then check that the
   expected models are listed.
5. Roll back by pinning `MAIA_IMAGE_TAG` to the previous `sha-<12>` in `infra/.env`
   and recreating both services. Never move a published version tag to do it.

## What is not part of a release

- No installer, no signed binary, no update feed: the product is served.
- No desktop workflows. `web-ci.yml`, `portal-ci.yml` and `images.yml` are the
  whole pipeline.
