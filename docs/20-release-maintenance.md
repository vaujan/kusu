# Release maintenance

Use this routine before preparing a release candidate. It complements the
[versioning policy](19-versioning.md) and [native release checklist](14-open-source-release-checklist.md).
Automated checks establish build and regression evidence; native testing and publication remain
separate gates.

## Everyday checks

```bash
pnpm changelog:generate
pnpm format
pnpm check
```

`pnpm check` verifies structured release notes and generated changelog consistency, formatting,
automated tests, lint, desktop and website type checks/builds, and the renderer bundle budget.
CI runs these same commands through the release check below.

Formatting covers maintained sources, scripts, configuration, and documentation. Vendored atomic
editor sources, bundled skills, generated KaTeX CSS, syntax fixtures, and local build/demo artifacts
are excluded so formatting does not change upstream code or semantic test inputs. Do not exclude
maintained application code to make a failing check pass.

## Full pre-release check

Close local app instances, then run:

```bash
pnpm install --frozen-lockfile
pnpm clean
pnpm check:release
```

`pnpm clean` removes desktop/website/Storybook build outputs, generated dependency notices, and
root compiler/lint caches. It deletes existing installers in `dist`, so preserve any artifacts you
need before running it. It leaves installed dependencies, source assets, vaults, demo/onboarding
profiles, and performance measurements intact. It accepts no custom paths.

`pnpm check:release` runs `pnpm check`, the full production and development vulnerability audit, the Storybook production
build, unsigned native unpacked packaging, and archive inspection. Run on Linux and Windows;
CI uses both. It does not publish, sign, or certify an installer. Experimental macOS packaging has
a separate native validation path; this archive inspector currently supports Linux and Windows.

`pnpm audit:all` runs the same full audit independently. Review the report, update affected tools
within supported versions, and document remaining findings rather than automatically applying
cross-major overrides. Do not expose development servers publicly. A clean production audit alone
is not evidence that development dependencies have no advisories.
The latest audit results are recorded in [the dependency audit follow-up](21-dependency-audit.md).

Package inspection rejects repository-only files, credential filenames, bundled development
overlays, missing application/license files, and a package whose identity/version differs from the
source candidate. Passing inspection does not prove there are no embedded secrets or that the
native UI works. CI's full-history Gitleaks job remains a separate required check.

## Keep the repository lean

- Remove confirmed obsolete code and its unused dependencies together. Check source, tests, stories,
  build scripts, CSS imports, and dynamic loading before deleting anything.
- Treat unused-code tool output as candidates for investigation. CSS/font imports, test-only
  helpers, Storybook, Electron entry points, and vendored modules can appear unused to static tools.
- Do not delete source artwork, fixtures, legal notices, vendored files, or local libraries merely
  because they are large. Runtime assets must have provenance and belong in the intended package.
- Keep developer-only tooling out of shipped code. Maintain separate native and browser build
  boundaries and preserve the main/Quick Capture performance budgets.
- Add curated notes for user-facing changes and keep generated outputs reproducible. Review the
  final diff, dependency lockfile, license notices, and secret-scan result for the exact commit.

## Final release gates

### Windows in-app updates

Installed Windows builds check the public `vaujan/kusu` GitHub Releases feed after
30 seconds and every four hours. Settings → About Kusu also offers a manual check.
The library sidebar offers a download button when an update is available, shows
download progress, and offers a restart button when it is ready to install. Update
errors offer a retry action. Settings → About Kusu also provides update controls.
Downloads and installation require a user action; quitting normally never installs
an update. Downloads use electron-updater's differential NSIS support when possible.
Development builds and experimental macOS/Linux builds do not check for updates.
Stable builds check the stable feed. Windows x64 builds from the experimental
installer workflow check tags in the `preview` channel. Users of older previews
must install an update-enabled preview manually once.

`pnpm release` builds signed x64 and arm64 Windows installers, then verifies and
collects both installers, their `.blockmap` files, `latest.yml`, and SHA-256 checksums
in `release-artifacts/`. The directory must not already exist. Upload all files to
a draft stable GitHub release with a tag matching the packaged version, then publish
only after all assets are present and native checks pass. Keep previous releases'
blockmaps available for differential downloads. No GitHub token belongs in the app.
The experimental preview workflow verifies and publishes `preview.yml` and the
Windows x64 blockmap alongside the preview installer.

Before enabling a public release, test two successive signed installed versions on
Windows: check, download progress, interrupted/offline retry, signature rejection,
restart, and preservation of library content and settings. Verify pending edits in
the main editor and separate note windows save before restart; a failed save must
block restart. Users of older builds must install an updater-enabled build once.

Prepare and commit the versioned candidate, then require green Linux/Windows and secret-scan CI.
`pnpm release` additionally checks a clean committed tree and prepared notes, runs the source
checks, full dependency audit, and Storybook build, builds signed Windows installers, and inspects the
resulting unpacked application. Check signatures and checksums, and complete native install,
upgrade, save/recovery, capture, accessibility, and uninstall testing before tagging or publishing.

Native interruption-recovery verification and the outstanding Windows testing/signing requirements remain
tracked in [the beta plan](18-beta-release-plan.md). A green maintenance check does not close those
gates automatically. Record OS, architecture, commit/version, commands, failures, accepted warnings,
and manual results in the release checklist. Update website download claims only after tested
public artifacts exist.
