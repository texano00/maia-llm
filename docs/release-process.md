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
`Get-AuthenticodeSignature` on **both** the installer and the application
executable and **fails the build** unless each one reports `Valid`.

A missing certificate is now a hard failure: the workflow stops before building
with `Signing secret is required` instead of quietly producing an unsigned
installer. That is deliberate — an unsigned build cannot be installed on a
machine with Smart App Control enabled, so publishing one would break upgrades
for exactly the users the release is meant to help.

The release notes written by the workflow name the signing authority
(`Signed by: <certificate subject>`), so a download can be checked against the
organization Microsoft trusts.

### What an upgrade looks like once signed

- Windows 11 with Smart App Control **on**: the updater downloads the new
  installer, runs it, and no block appears. The signature is what SAC checks; the
  previous unsigned 0.9.0 → 0.9.1 upgrade failed exactly there
  (*"Smart App Control has blocked part of this app"*).
- Windows 11 with Smart App Control **off**: the installer runs and SmartScreen
  may still show a reputation prompt until the certificate collects history.
- A user on an unsigned build who cannot upgrade: they must install the first
  signed release manually from the Releases page (properties → *Unblock*), after
  which in-app updates work.

## What end users should do meanwhile

- Download installers only from the project's GitHub Releases page.
- Compare the SHA-256 in `SHA256SUMS.txt` with the downloaded file.
- If SmartScreen appears: *More info* → *Run anyway*.
- If Windows reports that part of the app was blocked, check **Windows Security →
  App & browser control → Smart App Control**. With Smart App Control enabled an
  unsigned build cannot run; either switch it to evaluation/off (Windows requires a
  reinstall of the OS for that setting) or install the signed release.

### Smart App Control, precisely

Smart App Control (SAC) is stricter than SmartScreen: it blocks anything Microsoft
cannot vouch for through its own reputation service, so *even a self-signed binary is
blocked*. Two facts follow:

- Turning SAC **off** is one-way: Windows will not let you turn it back on without
  resetting the OS. It is the only way to run an unsigned build on a machine where it
  is enabled.
- The durable fix is a code-signing certificate issued to a verified organisation
  (OV or EV). Once `CSC_LINK_BASE64` and `CSC_KEY_PASSWORD` exist in the repository,
  every workflow build is signed automatically and the `Get-AuthenticodeSignature`
  gate refuses to publish an unsigned artifact.

### Signing a build locally

Signing on your own machine proves the pipeline end to end before a certificate is
purchased; it does **not** lift SAC, and Windows shows "Unknown publisher" until the
certificate is trusted.

```powershell
$env:CSC_LINK = "C:\certs\maia.pfx"
$env:CSC_KEY_PASSWORD = "..."
npm run -w @maia/desktop dist:win
Get-AuthenticodeSignature .\apps\desktop\release\*.exe | Format-Table -AutoSize
```

A self-made certificate (PowerShell, elevated) can stand in for a few tests:

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Maia LLM Test" `
  -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature `
  -NotAfter (Get-Date).AddYears(1)
Export-PfxCertificate -Cert $cert -FilePath C:\certs\maia-test.pfx -Password (Read-Host -AsSecureString)
```

To let *your* machine trust it: import the certificate into **Trusted Root
Certification Authorities** and **Trusted Publishers**. Other machines will still
warn — that is the reputation gap only a real certificate closes.

## Update feeds

`latest.yml` published next to each installer is what the in-app updater reads.
Updates install silently (`quitAndInstall(true, true)`), so the same signing rules
apply to the version being installed. macOS and Linux builds have no update feed
in this release: they are downloaded again.

## Platform matrix

| Target | Workflow | Artifacts | Signing |
|---|---|---|---|
| Windows x64 | `windows-dev-build.yml` | `MaiaLLM-Setup-<v>-x64.exe`, `.blockmap`, `latest.yml`, `SHA256SUMS.txt` | required (Smart App Control) |
| macOS arm64 | `desktop-platform-build.yml` | `MaiaLLM-<v>-arm64.dmg`, `SHA256SUMS-mac.txt` | none (`identity: null`) |
| macOS x64 | `desktop-platform-build.yml` | `MaiaLLM-<v>-x64.dmg`, `SHA256SUMS-mac.txt` | none |
| Linux x64 / arm64 | `desktop-platform-build.yml` | `MaiaLLM-<v>-<arch>.AppImage`, `MaiaLLM-<v>-<arch>.deb`, `SHA256SUMS-linux.txt` | none required |

Order matters for a release: run `windows-dev-build` first (it creates the
release), then `desktop-platform-build` with `publish_release=true` to attach the
macOS and Linux assets to the same tag. The landing page resolves whichever of
these the release actually contains and shows "coming soon" for the rest.

### Verifying a download

```bash
# macOS
shasum -a 256 MaiaLLM-0.9.2-arm64.dmg
# Linux
sha256sum MaiaLLM-0.9.2-x64.AppImage
# Windows (PowerShell)
Get-FileHash .\MaiaLLM-Setup-0.9.2-x64.exe -Algorithm SHA256
```

Compare against the matching `SHA256SUMS-*.txt` asset. A checksum proves the file
arrived intact from GitHub; the Authenticode signature is what proves who built it.

### macOS first launch (unsigned build)

The `.dmg` is not notarized. macOS stores the quarantine flag on downloaded files,
so the first launch is blocked with *"Maia LLM cannot be opened because the
developer cannot be verified"*. Confirm it once:

1. Open the `.dmg`, drag **Maia LLM** into *Applications*.
2. In *Applications*, right-click the app → **Open** → **Open** in the dialog.
   (Double-clicking only offers *Move to Bin*.)
3. If the dialog does not appear, allow it in **System Settings → Privacy &
   Security → Security** ("Open Anyway"), then launch again.

After that the app starts normally, including from the Dock. `xattr -dr
com.apple.quarantine "/Applications/Maia LLM.app"` achieves the same thing from a
terminal, and is what the release note suggests for scripted installs.

## Version and release checklist

1. Bump `version` in `package.json` and `apps/web/package.json` (must match), and
   `apps/portal/package.json` when the backoffice changed. The image workflow reads
   the **root** version, so it becomes the tag: `ghcr.io/texano00/maia-llm-web:<version>`
   and `…:sha-<12>`. The version tag is meant to be immutable; the workflow now
   refuses to overwrite an existing one and warns in the step summary, which is
   what catches a forgotten bump. `MAIA_APP_VERSION` overrides what a running
   container reports, so an image can be told its tag explicitly.
2. `npm run lint && npm run typecheck && npm test && npm run build && npm run verify:preload`
3. Trigger `windows-dev-build.yml` with `publish_release=true` (and `channel=beta`
   for prereleases).
4. Trigger `desktop-platform-build.yml` with `publish_release=true` so macOS and
   Linux assets land on the same tag.
5. Verify the release assets: installer, `.blockmap`, `latest.yml`,
   `SHA256SUMS.txt`, both `.dmg` files, both AppImages, both `.deb` files and the
   two platform checksum files.
6. Install the previous stable build and confirm the in-app banner offers the new
   version, installs silently, and reopens on the new version.
7. Smoke-test each platform with the checklist in
   `specs/004-platform-expansion/quickstart.md`.

> If a platform build is missing from the release, the landing page shows that
> combination as "coming soon" rather than linking to a 404 — a partially
> published release degrades instead of breaking.

## Which version is running

| Surface | Where it comes from |
| --- | --- |
| Product | `app.info.version` (build-information panel), `GET /health` → `version` |
| Backoffice | `GET /admin-api/version` → `portal` (this build) and `product` (read from the product's `/health`, `null` when unreachable), shown in the header |

Both read their own `package.json`, with `MAIA_APP_VERSION` winning when a
deployment wants to pin the reported value.
