# Changelog

<!-- Generated from releases/notes.json. Run pnpm changelog:generate; do not edit directly. -->

All notable changes to Kusu are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add a developer-only Windows Tauri preview for browsing existing vaults, with shared full-text search, local media previews, and live refresh of indexed notes and bookmarks.

### Fixed

- Let the Tauri preview reopen recorded vault items when its startup cache is missing or invalid.

## [0.0.13] - 2026-11-06

### Added

- Add pnpm stress to open an isolated, persistent 6,000-note vault for manual performance testing.

### Fixed

- Soften light-mode skeuomorphic control shadows and remove their inset border.
- Keep large-vault card browsing responsive by unmounting offscreen cards and avoiding unchanged preview renders.
- Keep Focus navigation and search responsive, and batch background link metadata updates in large vaults.
- Reduce cold indexing work and avoid full vault scans when checking Capture drafts, importing files, or saving notes.

## [0.0.12] - 2026-11-05

### Changed

- Highlight feature names in website descriptions with colorful inline icon badges.
- Give website headings IBM Plex Sans typography and add a beta, free-forever, open-source badge to both home pages.
- Add a dithered sunlit canopy behind the website hero and navigation, expand the demo without its gradient frame, and use light mode by default.
- Show the sidebar update action only when a downloaded update is ready to install. Check for and download updates in Settings.

### Fixed

- Explain update feed failures and confirm when Kusu is up to date.

## [0.0.11] - 2026-11-04

### Added

- Add a changelog page and a dark mode toggle to the Kusu website.

## [0.0.10] - 2026-11-03

### Changed

- Rename the app to Kusu. Existing vaults can be reopened from setup. App preferences and capture drafts use a new profile.
- Show a toast when a manual update check finds no update.

## [0.0.9] - 2026-11-02

### Changed

- Download updates from the sidebar, follow download progress, and restart to install when ready.

## [0.0.8] - 2026-11-02

### Fixed

- Explain missing stable releases and updater metadata without incorrectly blaming the internet connection.

## [0.0.7] - 2026-11-02

### Changed

- Show the sidebar update button only when an update is downloaded and ready to restart.

## [0.0.6] - 2026-11-01

### Added

- Choose a folder icon while creating a folder or subfolder.
- Add a Support Kusu settings section and English/Indonesian website sections with payment availability and contribution links.
- Add Windows in-app update checks, user-controlled downloads, and restart-to-update controls in the sidebar and Settings → About Kusu.

### Changed

- Use keycap components for focus-header and note-view tooltips, and center compact creation actions in square icon buttons.
- Refine skeuomorphic buttons and selects with solid raised surfaces, subtle edge highlights, and crisp keyboard focus outlines while preserving their existing rounded corners.
- Simplify the sidebar's empty folder prompt by removing its icon and using a smaller Create folder button.

## [0.0.5] - 2026-10-31

### Added

- Show the installed app version in Settings → About Kusu.

### Changed

- Add a folder icon and subtle dashed border to the sidebar's empty folder prompt.
- Unify the landing page feature previews, simplify their copy, and use borderless cards with hover backgrounds alongside icon cards for local/offline use, no required account, and free/open-source availability in English and Indonesian.

### Fixed

- Bundle actual publisher preview images for every landing-page sample link so the demo consistently demonstrates link previews.
- Show a loading state while fetching download options and clear it when releases are unavailable.
- Use the app mode button and scroll area in the writing preview, scale capture menus with the embedded scene, and disable capture submission and file actions in feature previews.

## [0.0.4] - 2026-10-31

### Added

- Development-only React Scan and React Grab overlays for spotting wasted renders and copying component source.
- Documented versioning policy and added validated, structured release notes with release preparation and consistency checks.
- Added repeatable release maintenance checks for formatting, Storybook builds, production dependency auditing, and unpacked application inspection.
- Added Vercel website deployment configuration and documentation.
- Added OS-specific landing-page downloads from the latest GitHub release, with installation guidance and source archives in English and Indonesian.
- Added native Windows, Linux, and macOS installer builds in GitHub Actions with SHA-256 checksums and explicit unsigned-test labeling.
- Added GitHub-hosted preview publication that verifies all four installers, source provenance, and checksums before publishing a draft prerelease.

### Changed

- Simplify library setup and include a starter guide in a Getting started folder in each new library.
- Use the One theme, system fonts, and 16px source text by default.
- Show a Create folder prompt when the sidebar has no folders.
- Add a development-only sidebar menu to reset onboarding without deleting library files, reset UI preferences, reload, and toggle DevTools.
- Simplified onboarding with a centered Kusu mascot, compact library actions, and a consistent layout throughout setup.
- Recolored the curled-tail application logo and matching website favicon with natural brown and cream tones.
- Keep Download Kusu and Source on GitHub as the landing page's main actions; the download page tracks installer availability.
- Removed obsolete library and draft migrations; vault opening no longer converts old Markdown metadata.
- Restricted packaged repository files, generated third-party notices, and added package inspection.
- Added Windows/Linux CI checks and a Windows release command that validates and requires signing without changing versions or publishing.
- Documented release scope, privacy, contributions, vulnerability reporting, and release verification.
- Display published experimental desktop previews on both download pages, including signing status and manual-update guidance.

### Fixed

- Keep macOS native window controls clear of library, note, and settings actions at every app zoom level, and use Command shortcuts for toolbar creation actions.
- Preserve existing item IDs when newly discovered files share or reuse a filesystem identity during vault reconciliation.
- Resolve pnpm commands on Windows with either executable or command-shim installations.
- Download the Electron runtime during dependency installation so desktop development starts successfully on a fresh setup.
- Recover interrupted item and folder moves, renames, reference rewrites, and metadata writes from persisted vault transaction journals.
- Check the standalone Vite configuration with the normal TypeScript checks and remove its duplicate import.
- Generate third-party notices from installed packages so Vercel builds do not depend on pnpm's cached package-store indexes.
- Flush staged note content before replacing the original in one rename, keeping a complete note at its original path if the save process exits before or after replacement.
- Update the application-menu regression check for the current focus workspace toolbar ownership.
- Watch canonical vault paths to prevent a native Windows crash when a folder uses a short path alias.
- Measure typing against the current search controls and isolate body autosave from title-driven file renames.
- Rebuild pnpm package-store indexes during Vercel installs so cached dependencies do not break website license generation.

### Security

- Remove the unused shadcn generator CLI and its vulnerable dependencies, vendor its shared styles with attribution, and update modern glob and minimatch tooling dependencies.
- Update supported development and packaging dependencies and retain exact security patch exceptions under the dependency age policy.
- Updated Electron, KaTeX, and Mermaid dependencies and patched transitive sanitizer/math dependencies.
- Restricted external links to HTTP(S), blocked renderer navigation and webviews, and authenticated IPC requests from registered app main frames.
- Patched Storybook and Vite development tooling and the transitive proxy-addr dependency after reviewing their security advisories.
- Updated Electron and Undici to patched releases after the installer workflow detected new advisories.
- Removed demo bookmark image copies without recorded redistribution permission.

### Performance

- Keep staged note saves in the internal temporary directory so autosave does not trigger a full-vault rebuild.

## [0.0.3] - 2026-08-17

### Added

- First Windows installer build (`build:win`) producing a signed NSIS setup.
- Find in note canvas.
- Split mode toggle by key code.
- `F12` devtools toggle.
- Toast explaining first-open vault indexing.
- Vim ex-command line (`:w`, `:q`, `:wq`, `:s/old/new/g`) with substitute support.
- Cursor offset saved and restored when switching between note editing modes.
- Sticky Vim search bar that stays pinned to the editor viewport.

### Changed

- Debounced search while keeping results visible as you type.
- Bound note saving to the changed item.
- Shortened the pin action label.
- Refreshed the interface palette around a violet-tinted theme with IBM Plex Sans headings.
- Rendered heading rules and tuned Acrylic material transparency against the new tokens.
- Pinned the Vim search and ex-command bars to the bottom of the editor viewport.

### Performance

- Paged focus rail mounting instead of mounting every item at once.
- Decoupled note previews from the keystroke path.
- Replaced note card previews with bounded snippets.
- Hardened and measured typing interactivity in the packaged runner.

## [0.0.2] - 2026-08-17

First tracked release of the local-first visual library.

### Added

- Local Kusu libraries with readable `note.md` and `item.json` files on disk.
- Obsidian-compatible vault storage: schema-v2 scanning, frontmatter, wikilinks, aliases, headings, note embeds, and image embeds.
- Markdown authoring through the inline New Item composer and a global `Ctrl+Shift+Space` Quick Capture popup.
- Milkdown-based editor with Read, Live, highlighted Markdown, and linked Split presentations.
- Clipboard image paste and file paste/drag-and-drop with recoverable staging and collision-safe imports.
- URL capture with offline-safe `.url` shortcuts and background metadata enrichment.
- Collections as nested folders, plus Archive, Trash, and a Pinned destination.
- Focus master-detail view, Masonry view, and Uniform Grid view with persisted preferences.
- Search by title, note, URL/domain, and filename, with type filters, attachment visibility, and sorting.
- Task checkboxes in Markdown, syntax-highlighted code, Mermaid diagrams, KaTeX math, and image zoom with captions.
- Inline `F2` rename and `Delete` item commands, range selection with shift-click anchor, and auto-scroll to the active item.
- Type badges in the Focus index and action errors surfaced as toasts.
- Performance foundation: atomic rebuildable library snapshot, bounded scanning, 100-card progressive rendering, and LRU preview caching.

### Changed

- Restyled interface around a base-luma theme and Inter Variable sans typography.
- Restored search, filters, and Focus view across app restarts.
- Restored note cursor and scroll position when entering live editing.
- Deferred note editor modules and released idle Quick Capture windows to reduce memory use.

### Fixed

- Read-mode task lists splitting text into flex columns.
- Note cursor dropping below the pane bottom while typing.
- Rename triggering from anywhere in the detail pane instead of a single hot spot.

## [0.0.1] - 2026-08-13

### Added

- Hello, world!
