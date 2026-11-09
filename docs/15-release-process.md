# Preparing a public release

Windows is the supported release target. macOS and Linux packaging commands are for experimental local testing until their native installation checks are completed. Electron 44 requires a 64-bit platform; macOS testing requires macOS 13 or later.

## Prepare the source

Start with [release maintenance](20-release-maintenance.md): preserve any needed build artifacts,
run `pnpm clean`, and run `pnpm check:release` for a fresh source, Storybook, audit, and package
inspection pass. The unsigned package produced here is for verification only.

1. Work from a clean checkout with Node.js 24.19.0 and pnpm 11.26.0. Run `pnpm install --frozen-lockfile` and `pnpm check`. CI repeats these checks on Linux and Windows and inspects an unsigned unpacked package. Windows CI also builds and retains an unsigned x64 test installer for seven days. A green CI build is not a signed public installer.
2. Run `pnpm audit:all`. Resolve production and development-tool advisories before release. Do not hide findings by raising the severity threshold.
3. Review the full-history secret scan and the asset provenance inventory before source publication. Immediately after making the repository public, enable private vulnerability reporting in GitHub settings and verify it before announcing the launch. GitHub provides this reporting feature for public repositories. No automated scan can establish asset ownership or guarantee the absence of secrets.
4. Follow [the versioning policy](19-versioning.md). Edit `unreleased` in `releases/notes.json`, then run `pnpm release:prepare <version> <YYYY-MM-DD>` with the actual preparation date in Asia/Jayapura. Review and commit the root package version, structured notes, and generated changelog together. Run `pnpm release:verify`. Do not tag until the installer passes verification. The release command itself never changes the version or creates a tag.

## Build and inspect on Windows

Run `pnpm release` on Windows with the signing credentials supplied through the signing provider or electron-builder's documented environment variables. Never put credentials in the repository or command arguments. This command checks version/notes consistency, empty unreleased notes, and a clean committed tree, runs the complete verification suite and dependency audit, then builds with `forceCodeSigning=true` and `--publish never`. It fails if signing is unavailable. Local `build:win` and CI packaging may be unsigned and must not be mistaken for approved public releases.

Run `pnpm package:verify` after packaging. Generated THIRD_PARTY_NOTICES.txt, Kusu LICENSE, and Electron's LICENSE.electron.txt and LICENSES.chromium.html must be present. Confirm the installer signature and publisher using Windows signature inspection. Generate SHA-256 checksums with `Get-FileHash` for every released installer.

Test the x64 and ARM64 installers on matching clean Windows systems before advertising each architecture. Check installation, offline launch, upgrade, uninstallation, retained library files, shortcut conflicts, quick capture, note saves, and conflict/recovery behavior. Record the results in the release checklist. Do not publish an architecture solely because cross-compilation succeeded.

## Publish after verification

Tag the exact verified source commit, attach the signed installers and checksums to its GitHub release, and provide corresponding source access. Include installation instructions, supported OS/architectures, known limitations, and backup/recovery advice. Installed Windows builds can check for updates in Settings → About Kusu. Users choose when to download and restart to install.

Update the landing page to link to the real release and public source when available. Until then its browser-demo language is intentional. Download and install the public artifact once more before announcing it.

No command in this process publishes automatically. Signing, native installer checks, source publication, and the announcement are separate release gates.

## Back up and recover

Close Kusu and copy the entire library folder, including hidden `.kuskus` metadata and attachments, to a separate location. Keep ordinary Markdown/files together with their relative attachment paths. Back up the user profile separately if draft capture sessions and preferences matter. Do not rely on Trash as a backup.

After a crash or conflict, preserve a copy of the vault and profile before attempting recovery. Reopen the affected vault, inspect conflicting text and missing-file notices, and compare files with the backup. Reproduce bugs on a disposable copy. Never delete `.kuskus` or overwrite a conflicting note as an automatic recovery step.

## Runtime download troubleshooting

The first Electron download is over 100 MB and may take several minutes on a slow connection. Keep one download running while transferred bytes are increasing; repeated short time limits discard partial downloads. Run `pnpm exec install-electron` explicitly and confirm `pnpm exec electron --version` before debugging the app itself. Use official release artifacts and retain checksum verification.

CI caches Electron runtimes and packaging tools by operating system, architecture, and lockfile. A cold cache still requires a full download. If acquiring a runtime was interrupted, verify a fresh package rather than inspecting a leftover `dist` archive.

To inspect a cross-compiled Windows package on Linux, run `pnpm package:verify win32`. This checks archive contents and required notices, including electron-builder's `LICENSE.electron.txt`; it does not establish Windows installation or signing correctness.

When cross-building Windows on Linux, NSIS uses Wine to generate its uninstaller. Wine needs an initialized prefix owned by the current user and working system services. A partial setup stub from a failed Wine run is not an installer. Prefer the Windows CI artifact if the local Wine environment cannot finish initialization; signing and clean-machine checks are still required.

## Cross-platform installer builds

The **Build desktop installers** Actions workflow creates Windows x64 NSIS setup,
Linux x64 AppImage, and macOS ARM64/Intel DMG files on native hosted runners.
It runs on packaging/app pull requests and can also be dispatched manually once
merged into the default branch. Each job uploads an archive containing its installer,
`SHA256SUMS.txt`, and `BUILD-INFO.txt` for 14 days. Download the matching artifact
from the workflow run; extract the archive before using its installer.

These are unsigned test builds; macOS uses ad-hoc signing without notarization.
They do not satisfy the public release signing or native installation checks above.
The workflow never publishes a release or changes repository visibility. GitHub
requires repository access to download Actions artifacts, so do not link these
archives from the public website. See [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).

After native verification, build signed Windows installers using `pnpm release`.
For macOS distribution, supply a Developer ID certificate through `CSC_LINK` and
`CSC_KEY_PASSWORD` plus Apple's notarization credentials, then run `pnpm build:mac`;
keep `mac.notarize` enabled. See [electron-builder signing](https://www.electron.build/v26/docs/features/code-signing/)
and [macOS options](https://www.electron.build/v26/docs/api/app-builder-lib.interface.macconfiguration/).
Linux AppImages do not use Windows or Apple signing credentials.

The website currently reads `vaujan/kusu` public GitHub releases. That repository
was made public on 2026-10-25 with owner approval. Public experimental previews
are labeled as unsigned test builds, with checksums and corresponding tagged source.
They do not establish native installation verification or signing readiness. Never embed GitHub access tokens in the website.

### Publishing an experimental preview

The **Publish experimental preview** workflow accepts a successful **Build desktop
installers** run ID and an existing draft prerelease tag. Create the draft with its
target set to the full `Source commit` SHA recorded in the build's `BUILD-INFO.txt`
(the PR merge commit for PR builds), and explain signing and testing limitations in
the release notes. Use a prerelease tag such as `v0.0.3-preview.1`; it must match
the version inside the installer filenames.

Dispatch the workflow from the reviewed source ref. It downloads artifacts inside
GitHub, requires all four installers and the Windows x64 `preview.yml` and NSIS
blockmap, and verifies every SHA-256 hash and the source commit against the draft.
It uploads those files plus a combined `SHA256SUMS.txt` and `BUILD-INFO.txt`, then
publishes the prerelease. Failed verification or uploads
leave the release unpublished. This flow never creates a stable release and does
not satisfy the signed/native installation gates for one. Public preview downloads
appear automatically on both website download pages, with experimental signing
status and platform-specific update guidance. Windows users on earlier previews
must install an update-enabled build manually once.
