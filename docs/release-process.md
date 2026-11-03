# Release process and Windows signing

## Why Windows blocks unsigned builds

Windows trusts executables by reputation. A downloaded installer with no
Authenticode signature — or one signed with a certificate that has no history —
triggers:

- **"Windows protected your PC"** (SmartScreen) on first run of the installer.
- **"Part of this app has been blocked"** when Smart App Control or Defender
  Application Control is enabled, because only signed binaries are allowed to run
  at all.

SHA-256 checksums and a public source repository do not change that: the decision
is made locally by Windows from the signature and its reputation, not from the
hash. The only real fix is to sign every executable with a certificate issued to a
verified organisation, and to keep signing with the same certificate so reputation
accumulates.

| Certificate | Effect |
| --- | --- |
| **EV (Extended Validation)** | Immediate SmartScreen trust, no reputation warm-up. |
| **OV (Organisation Validation)** | Trust builds up after a few hundred clean installs. |
| Self-signed | No improvement; still blocked. |

## Wiring signing into this repository

The workflow `.github/workflows/windows-dev-build.yml` signs automatically when a
certificate is present in repository secrets:

1. Export your certificate as a `.pfx` (including the private key).
2. Base64-encode it: `base64 -w0 certificate.pfx > certificate.txt`.
3. Add repository secrets:
   - `CSC_LINK_BASE64` — the contents of `certificate.txt`
   - `CSC_KEY_PASSWORD` — the `.pfx` password
4. Trigger a build:

```bash
gh workflow run windows-dev-build.yml --ref main \
  -f channel=stable -f publish_release=true
```

The workflow decodes the certificate into the runner's temp directory, exports
`CSC_LINK`, and electron-builder signs both the app executable and the NSIS
installer with a timestamp. A verification step then runs
`Get-AuthenticodeSignature` and **fails the build** if signing was expected but the
installer is not validly signed — so an unsigned artifact can never be published
once the secret exists.

Without the secret the build still succeeds and prints
`No CSC_LINK_BASE64 secret: building an unsigned installer.`

## What end users should do meanwhile

- Download installers only from the project's GitHub Releases page.
- Compare the SHA-256 in `SHA256SUMS.txt` with the downloaded file.
- If SmartScreen appears: *More info* → *Run anyway*.
- If Windows reports that part of the app was blocked, check **Windows Security →
  App & browser control → Smart App Control**. With Smart App Control enabled an
  unsigned build cannot run; either switch it to evaluation/off (Windows requires a
  reinstall of the OS for that setting) or use a signed build.

## Update feeds

`latest.yml` published next to each installer is what the in-app updater reads.
Updates install silently (`quitAndInstall(true, true)`), so the same signing rules
apply to the version being installed.

## Version and release checklist

1. Bump `version` in `package.json` and `apps/desktop/package.json` (must match).
2. `npm run lint && npm run typecheck && npm test && npm run build && npm run verify:preload`
3. Trigger the workflow with `publish_release=true` (and `channel=beta` for
   prereleases).
4. Verify the release assets: installer, `.blockmap`, `latest.yml`,
   `SHA256SUMS.txt`.
5. Install the previous stable build and confirm the in-app banner offers the new
   version, installs silently, and reopens on the new version.
