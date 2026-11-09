# Development workspaces

Use these workspaces to try changes without opening your own library. Start with the [setup instructions](../README.md#run-from-source).

Development windows load [React Scan](https://github.com/aidenybai/react-scan) and [React Grab](https://github.com/aidenybai/react-grab) so you can see re-renders and copy a component's source for an agent. Neither package is included in packaged builds. React Scan's toolbar appears in the corner. Hold **Alt+C** to start React Grab, hover a control, then press **C** to copy its component stack.

## Component stories

The shadcn components are checked in as source. Their shared Tailwind stylesheet is
vendored from shadcn 4.22.1 in `src/renderer/src/assets/shadcn.css`, with its MIT license
in `third-party/shadcn.LICENSE.txt`. The generator CLI is not an installed dependency;
it brought in an unpatched `deepmerge` vulnerability without being needed to build
the application.

The dependency audit excludes GHSA-g3hv-75wg-m249 only because minimatch 3.1.5 and
5.1.9 do not contain the advisory's `firstPhasePreProcess` optimizer. All modern
minimatch copies resolve to 11.0.1 or newer. `tests/security-dependencies.test.cjs`
checks both the legacy source and the lockfile so the exception cannot hide a
vulnerable modern copy. See the [upstream advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249).

```bash
pnpm storybook
```

Storybook previews renderer components in the browser at `http://localhost:6006`. Use its light/dark toolbar control to check both color modes. Stories cover buttons, file cards, folder dialogs, note cards, Markdown reading, and the live note editor. The note stories use local sample content; edits and checklist changes stay inside the preview. **App → Library states** renders the whole app with empty, notes-only, mixed-media, and missing-file libraries. These app stories use browser fixtures for the Electron APIs, so library changes do not touch files on disk. The accessibility panel checks the rendered stories. For workflows that need a real library, use `pnpm dev:demo` instead. Run `pnpm build:storybook` to verify the standalone story build.

## Fresh onboarding workspace

```bash
pnpm dev:onboarding
```

Each launch clears `.onboarding/` and starts with no library, saved theme, or other app preferences. The Create Library folder picker starts in `.onboarding/libraries/`; create test libraries there so the next launch clears them too. Libraries created elsewhere are not removed. This profile is separate from the normal development, demo, and packaged app profiles. Close the onboarding app before starting another run.

To clear the workspace without starting the app, run `pnpm onboarding:reset` after closing it. This command only clears `.onboarding/`; it does not reset a normal `pnpm dev` or demo session.

In a running development app, open **Development** in the sidebar for testing actions:

- **Reset onboarding (keep library files)** forgets the active library and reloads into setup. Existing library files and capture recovery data remain available when you reopen the library.
- **Reset UI preferences** clears saved renderer preferences and reloads the app.
- **Reload app** reloads the main window.
- **Toggle DevTools** opens or closes Electron DevTools.

The menu and its backend actions are available only in development mode.

## Isolated demo environment

Run Kusu with a populated, repository-local profile:

```bash
pnpm dev:demo
```

The command creates `.demo/Fauzan’s Library` and `.demo/user-data` on first use. This profile is completely separate from the normal development and packaged-app profiles. Changes made while testing persist between demo launches.

After closing the demo app, restore the original mock folders and data at any time:

```bash
pnpm demo:reset
```

Use `pnpm demo:seed` to create a missing demo library without resetting existing demo changes. The fixture represents a designer-developer actively dogfooding Kusu, with recent working notes, original local visuals in several proportions, healthy URL references, a portable note attachment, partially populated folders, one Trash item, and a dedicated Markdown Lab containing focused feature fixtures plus a long stress document.

If `.demo` already exists, run `pnpm demo:reset` once to add or restore the canonical Markdown Lab. `demo:seed` intentionally preserves an existing profile and will not overwrite local dogfooding changes.

## Manual large-vault stress testing

Build the production app, then open it with an isolated 6,000-note vault:

```bash
pnpm build
pnpm stress
```

The command uses the optimized build in `out/`, without React Scan, React Grab, or the automated
benchmark's interactions and shutdown timer. Re-run `pnpm build` after changing application code.
The window stays open for manual testing until you close it.

To use a larger vault:

```bash
pnpm stress --items=10000
pnpm stress --mixed --items=6000
```

Each size has its own vault and profile under `.performance/manual-<count>/`; mixed fixtures use
`.performance/manual-mixed-<count>/`. Test edits, preferences,
and the cached index persist, so subsequent launches exercise cached opening. The count is the initial
seed size; archived, deleted, and newly created notes persist too. Close the test app before reopening
the same profile. This workspace is separate from your normal vault and demo profile.

Try deep scrolling, selecting ranges, switching visual/grid views, searching, opening notes, and
moving or archiving selections. Compare interactions near the top and after scrolling far down.
The default fixture contains Markdown notes. `--mixed` creates 60% Markdown notes, 20% PNG images,
10% local URL shortcuts, and 10% PDFs, distributed across twelve folders at 6,000 items. The URLs are
blocked loopback examples, so background enrichment exercises failure states without contacting
external sites. Use `pnpm stress --seed-only` to prepare the fixture without opening a window.

## Tauri desktop preview

Follow the [Tauri migration checklist](23-tauri-migration.md) for progress and release gates.

The Windows preview runs the existing workspace in WebView2 with the same demo adapter used by
the browser preview. Note edits are temporary. The window title identifies the preview.

Install Rust and the Windows build tools described in the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows). Then run
`pnpm tauri:dev`. To build a release executable, run `pnpm tauri:build` and open
`src-tauri/target/release/kusu-tauri-preview.exe`.

The preview starts with sample notes. Use **Open library** to pick a disposable schema-v2 vault
previously indexed by Electron. The preview remembers that folder in its own profile. It uses
`.kuskus/index/library-v1.json` when available; if that cache is missing, corrupt, or belongs to
another vault, Rust reads the existing item and collection records and their visible files.
Files without records and newly added folders are not discovered yet. To pin a snapshot for a
test run, set the environment variable before launch.

```powershell
$env:KUSU_TAURI_SNAPSHOT = 'C:\path\to\library-v1.json'
pnpm tauri:dev
```

The preview uses the snapshot for browsing and shares full-text matching and ranking with
Electron. To open images and PDFs, point the variable at the index inside a disposable test vault
and keep the media files in that vault. Rust resolves previews by item ID, checks that the file
stays inside the vault, and generates smaller images for cards. Vault reconciliation, durable
saves, and native capture are separate migration work.

Run the Windows cache-recovery smoke against the release executable:

```powershell
node scripts/smoke-tauri-record-recovery.cjs src-tauri/target/release/kusu-tauri-preview.exe
```

The smoke creates a disposable vault and WebView2 profile. It checks missing, corrupt, and
foreign caches, exact note contents, folder IDs, search, bookmark targets, PDF bytes, and note
identity after rename and reopen. It also checks that recovery leaves files and records unchanged.
