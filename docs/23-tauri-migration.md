# Tauri migration

**Status** · Windows preview works. The first shell comparison and a folder picker for indexed
vaults are in place. Rust refreshes indexed Markdown notes and bookmarks from disk. Full
reconciliation and the release comparison remain open.

**Last updated** · 2026-11-07

Kusu will move its desktop shell from Electron to Tauri and its vault engine from TypeScript to
Rust. The existing React workspace, Markdown editor, and PDF reader carry forward. The migration
aims to reduce desktop resource use while preserving the [golden workflows](01-golden-workflows.md)
and the [vault storage contract](03-storage-contract.md).

Update this checklist as work lands. Mark a box complete once the change works through the normal
app flow and record the build, fixture, checks, and result in [Verification log](#verification-log).
Leave platform-specific work open until it passes on that platform. Keep Electron available for
releases until the Tauri candidate meets the cutover gates.

## 1. Windows preview

- [x] Build and launch a Windows Tauri release executable with the existing React workspace.
- [x] Open a cached snapshot and find a known item in a 6,000-note fixture.
- [x] Share full-text matching and ranking with Electron, including note-body search.
- [x] Integrate window controls into the toolbar. Verify maximize, restore, and the **Use system
      title bar** setting, including persistence after restart.
- [x] Read local PDFs and images by item ID inside the test vault. Verify selectable PDF text,
      Find in PDF, 512 px image thumbnails, and original images in detail.

Run the [preview setup](development.md#tauri-desktop-preview) with sample data or a disposable
vault. Today, Tauri opens a saved snapshot and applies note edits in memory. The release executable
is an unbundled preview.

## 2. Measure the two shells

- [x] Run three initial release-build trials per shell on the same Windows machine. Use the same
      5,000-note fixture and a second fixture with images and PDFs. Use isolated app profiles and
      record the runtime versions, build revision, and fixture.
- [ ] Record cold and cached startup to first usable card, total process memory at idle and after
      browsing, CPU while idle and scrolling, search results latency, editor keystroke-to-paint,
      and scroll frame times. Include WebView2 processes in Tauri totals and Chromium processes in
      Electron totals. Report medians and p95 where the samples support them.
- [ ] Record executable, installed, and installer sizes separately as comparable artifacts become
      available. Repeat the resource comparison after the live vault engine and durable saves land.
- [ ] Agree on the minimum resource improvement before advancing to a release cutover. A proposed
      initial target is at least **25% lower median settled memory** in the matched workflow, with
      no material regression in startup, browsing, search, or editor responsiveness. Keep the
      repository’s [interaction budgets](13-interaction-responsiveness-plan.md) as release gates
      and verify the actual timing points in the harness.

The earlier Electron run measured about **784 MB median settled working set**, **24.8 ms p95
search IPC**, and **17.8 ms p95 note keystroke-to-paint** across three packaged typing runs on a
5,000-note fixture. This is a historical reference. The snapshot preview and Electron do different
backend work, so repeat measurements with equivalent workflows before drawing cutover conclusions.

### Initial Windows comparison

The 2026-11-06 run used two 5,000-item fixtures from `scripts/performance-fixture.cjs`, Chrome
152.0.7977.167 in packaged Electron, and WebView2 156.0.4314.58 in the unbundled Tauri release
preview. Both executables were built from the working tree based on `7929380`. The comparison
alternated shells and used three isolated profiles per shell and fixture. Each profile opened
once and then reopened. Both runs began with a vault index already on disk.

| Fixture and shell | First profile median | Reopen median | Idle memory median | After interaction memory median | Search median | Scroll frame p95 |
| ----------------- | -------------------- | ------------- | ------------------ | ------------------------------- | ------------- | ---------------- |
| Notes · Electron  | 1,231 ms             | 1,352 ms      | 652 MiB            | 807 MiB                         | 135 ms        | 83 ms            |
| Notes · Tauri     | 1,204 ms             | 1,139 ms      | 458 MiB            | 620 MiB                         | 131 ms        | 83 ms            |
| Mixed · Electron  | 1,362 ms             | 1,486 ms      | 621 MiB            | 780 MiB                         | 128 ms        | 83 ms            |
| Mixed · Tauri     | 1,489 ms             | 1,387 ms      | 454 MiB            | 640 MiB                         | 199 ms        | 117 ms           |

The test measured launch to a visible note card, then sampled working sets across each app and
its renderer processes. It scrolled the library over 40 animation frames and typed one search
query. The app executable sizes were 235.4 MiB for Electron and 17.2 MiB for Tauri. Installed
sizes and installer sizes are still open. The raw run data is in the local
`.performance/tauri-shell-comparison.json` log.

Median search time was 135 ms versus 131 ms for notes and 128 ms versus 199 ms for mixed.
The respective p95 values were 198 ms versus 188 ms and 145 ms versus 260 ms. Median CPU
during the combined scroll and search sample was 114% versus 175% for notes and 118% versus
176% for mixed, on a scale where 100% is one core. These short samples include background
renderer work. Record idle, scroll, and search separately in the release comparison.

Tauri used about 23% less memory after interaction in notes and 18% less in the mixed vault.
Mixed-vault scrolling and search were slower. Electron could reuse disk thumbnails across trials
while the Tauri preview generated them from the original files. Retest with equivalent thumbnail
cache conditions, add uncached vault startup and editor typing, and investigate the mixed-vault
regression before using these results as a release gate.

### Mixed-vault comparison after the Rust refresh changes

The 2026-11-06 run reused the 5,000-item mixed fixture and its saved index and thumbnails.
It used three isolated profiles per shell, each opened twice. Electron used Chrome
152.0.7977.167 and the Tauri release preview used WebView2 157.0.4341.42. Memory includes
the renderer process tree. CPU samples use 100% for one core. The settling sample started
one second after the first note card appeared.

| Shell    | First profile median | Reopen median | Settling memory | After interaction | Settling CPU | Scroll CPU | Search CPU | Search median | Scroll frame p95 |
| -------- | -------------------- | ------------- | --------------- | ----------------- | ------------ | ---------- | ---------- | ------------- | ---------------- |
| Electron | 3,308 ms             | 2,701 ms      | 632 MiB         | 785 MiB           | 98%          | 109%       | 39%        | 127 ms        | 183 ms           |
| Tauri    | 3,050 ms             | 2,612 ms      | 448 MiB         | 594 MiB           | 51%          | 181%       | 57%        | 170 ms        | 200 ms           |

Tauri used about 24% less memory after interaction. Mixed-vault scrolling and median search
were slower. The Electron executable was 235.4 MiB and its unpacked directory was 599.7 MiB.
The unbundled Tauri executable was 18.3 MiB and used the system WebView2 runtime. Comparable
installed and installer sizes, uncached startup, and durable editor timing remain open.
Raw samples are in the local `.performance/tauri-case-rename-comparison.json` log.

## 3. Open live vaults in Rust

- [ ] Add a native folder picker and persist the selected vault in the Tauri profile. Verify
      reopening, switching, canceling, and recovery when a vault is missing or unreadable.
- [x] Keep Rust vault logic independent of Tauri window and IPC types. Let the Tauri command layer
      translate renderer requests into vault operations and typed results.
- [ ] Port contained filesystem reads, note and bookmark parsing, and stable item and folder IDs.
      Compare against Electron on copies of schema-v2 vaults, including Obsidian folders, Unicode
      names, case-only renames, duplicate content, missing files, and Windows junctions.
- [x] Refresh existing indexed Markdown notes from disk on startup, focus, and file changes.
      Keep temporary preview edits in memory and update the visible library and search together.
- [x] Parse and refresh existing indexed Windows Internet Shortcuts from disk. Disable invalid
      targets and keep bookmark identity when the shortcut is repaired.
- [x] Open previously recorded items and collections without a valid startup cache. Read note
      contents from visible files, preserve record IDs, and reject malformed or linked records.
- [ ] Port cached overview and background reconciliation. Keep startup responsive while indexing.
      Refresh on external edits, rename, focus, and restart. Discard results from a previous vault
      session and use the same revision for search and the visible library.
- [ ] Move search, media, and note detail to the live vault engine. Verify the existing ranking,
      exact note content, PDF reading, note attachments, and missing-media states. Remove the
      snapshot adapter from the production desktop path when the live path passes.

## 4. Transfer writes and recovery together

- [ ] Give Rust sole authority over vault writes, reconciliation records, and transaction recovery
      in the Tauri build. Keep the schema-v2 on-disk contract and preserve ordinary user-readable
      files. Test any legacy vault behavior that remains part of the supported open flow.
- [ ] Port note creation and atomic autosave, including conflict detection with external edits and
      another window. Keep the caret, undo history, and editor instance stable through the first
      save. Confirm that autosave triggers zero full vault scans.
- [ ] Port imports, attachment placement, bookmark persistence, folder and item moves, archive,
      Trash, restore, and reference rewrites. Verify that IDs and references survive moves,
      renames, and reopen.
- [ ] Port journals and durable capture receipts. Terminate the process before commit, during a
      transaction, and after commit but before the reply. Verify recovery, preserved drafts,
      exact file contents, and retry without duplicate capture or partial moves.
- [ ] Verify path validation, filesystem links, malformed metadata, and bookmark network limits.
      Test against disposable copies before any release candidate can write to a user vault.

## 5. Restore desktop workflows

- [ ] Complete settings and profile persistence for supported preferences. Verify both title-bar
      modes, theme and zoom, keyboard focus, and reopen behavior.
- [ ] Restore file drag-and-drop, clipboard and attachment imports. Verify the Electron behavior
      through each normal entry point.
- [x] Verify native reveal, image open, and browser links in the Windows release app.
- [ ] Restore global quick capture and detached note windows. Verify focus return, draft handoff,
      keyboard shortcuts, close with pending edits, and multiwindow conflicts.
- [ ] Verify the Markdown editor in the packaged webview, including IME, selection, undo,
      keyboard navigation, Live Preview, source and split views, and note links.
- [ ] Verify browsing and media with large libraries, including selection and scroll retention,
      image cards, PDF selection and search, and offline use.

## 6. Package, compare, and cut over

- [ ] Produce and verify a Windows installer. Check signing, clean install, reinstall, uninstall,
      profile and vault selection, and the supported update flow. Follow the
      [release process](15-release-process.md) and [release checklist](14-open-source-release-checklist.md).
- [ ] Decide the macOS and Linux release scope before retiring their Electron builds. For each
      platform retained in the Tauri release, verify the installer and the same editor, capture,
      media, and window flows on its native webview.
- [ ] Run the performance comparison again on the packaged release candidate. Publish the actual
      results with the Windows and platform-specific workflow checks.
- [ ] Test upgrading from the supported Electron release with a copy of a vault and app profile.
      Verify the supported recovery path using a backup before distributing the candidate.
- [ ] Promote Tauri when data safety, interaction, performance, and packaging gates pass. Remove
      superseded Electron runtime code and release wiring once the Tauri release covers the
      agreed platform scope. Keep the browser demo and its renderer checks in the release pipeline.

## Verification log

| Slice           | Evidence                                                                                                                                                                                        | Open work                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Windows preview | Release executable opened a 6,000-note snapshot and found the expected note.                                                                                                                    | Live vault open and reconciliation.                                 |
| Title bar       | Windows release smoke test verified the integrated controls, native frame, live switch, and saved preference after restart. The app suite passed 440 tests at this checkpoint.                  | Full desktop settings and multiwindow behavior.                     |
| Local media     | Windows release smoke test rendered a 512 px card thumbnail and the original 2172 × 724 WebP. PDF text rendered and Find returned two matches. Two Rust tests and 13 targeted app tests passed. | Note attachments, live media refresh, and matched performance runs. |

For the next entry, record the date, revision, OS, fixture, commands or manual workflow, actual
result, and any open regression. Keep measurements separate from proposed targets.

On 2026-11-06, an isolated Windows debug build opened the native folder picker and returned
cancellation without switching libraries. A seeded profile reopened its vault and showed the
recovery screen when pointed at a missing folder. Rust tests covered saved selection replacement,
Unicode paths, and opening the copied index at its selected location. Confirm successful selection
and switching through the packaged UI before checking off the picker.

The preview now reuses an existing, current thumbnail up to 512 px from the selected vault.
Rust tests cover reuse, stale cache regeneration, and vault-relative media paths. The updated
Windows release passed the image and PDF smoke tests. All five Rust tests and 440 app tests passed.

A follow-up on the same mixed vault used three isolated profiles per shell with the vault's
existing thumbnails available to both. After interaction, median working set was 805 MiB for
Electron and 635 MiB for Tauri, about 21% lower. Median search was 188 ms versus 201 ms, and
scroll frame p95 was 100 ms versus 117 ms. This run still misses the proposed memory target
and mixed browsing gate. Raw observations are in the local
`.performance/tauri-shell-comparison-cache.json` log.

A separate Markdown source typing run on the notes fixture recorded 30 input events per shell.
Input to the second animation frame was 27.6 ms median and 47.2 ms p95 in Electron, versus
23.6 ms median and 57.7 ms p95 in Tauri. This measures renderer response during typing. The
release comparison still needs equivalent durable autosave and uncached vault startup.
Raw observations are in `.performance/tauri-shell-typing.json`.

The Windows release preview rendered an embedded WebP from a parent folder while a sibling
attachment listed in the snapshot was missing on disk. Rust checks note and attachment IDs
together and rejects references that escape the vault. Six Rust tests and 25 targeted app tests
passed. The image card, image detail, PDF text layer, and Find in PDF also passed their release
smoke tests. Live attachment reconciliation remains open.

The Windows release preview revealed an indexed file in Explorer and opened a PNG through the
default app. It rejected an unknown item ID, opened an HTTP link through the default browser, and
blocked file URLs and external navigation inside the app webview. Rust tests covered disallowed
image extensions and revealing the saved record for a missing file. Nine Rust tests and all 440
app tests passed. The attachment rendering smoke test passed again on this release.

The Windows release now reads Markdown for already indexed notes through Rust. Startup still
renders the cached overview first. A debounced vault watcher refreshes affected notes, and focus
rechecks the indexed note set. The Windows smoke test changed a note on disk without refocusing
the app and verified that the new text reached detail and search at the same revision. A missing
note showed as unavailable, and the preview kept an in-memory edit while a second application
changed that file on disk. Eleven Rust tests, all 440 app tests, and the 6,000-note search smoke
test passed. New files, rename identity, and attachment discovery still
depend on the saved index and remain open.

The Windows release watcher also refreshes indexed `.url` shortcuts. A smoke test changed a
bookmark to a YouTube URL, verified the video type and new search result, replaced it with a
file URL, then repaired it with an HTTPS URL. The same bookmark ID survived, stale preview
metadata cleared, and the preview left the shortcut file untouched. Thirteen Rust tests,
all 440 app tests, and the Windows note watcher and embedded-image smoke tests passed.
Discovery of new shortcuts and remote enrichment remain open.

On 2026-11-06, on Windows build 19045 with the working tree based on `7929380`, the Rust
vault modules no longer depend on Tauri types. Note and bookmark refresh return typed Rust
updates with the same renderer fields. `cargo test --offline --locked --manifest-path src-tauri/Cargo.toml`
passed all 13 tests, including serialization of note and bookmark changes from temporary vaults.
The release build with `tauri/custom-protocol` passed the local note and bookmark watcher smoke
tests against disposable indexed vaults. The tests verified search updates, missing notes,
temporary note edits, and invalid shortcut recovery.

An isolated Windows release preview built with the picker smoke configuration opened the native
folder dialog. The automation could read its controls but could not target the folder field, so
successful selection and switching through the release UI still need verification.

On 2026-11-06, on Windows build 19045 with the working tree based on `7929380`, Rust checked
each component of indexed vault paths for links and rejected Windows alternate data streams.
All 15 Rust tests passed. The release preview read and searched a note in a nested Unicode
folder and kept notes behind both internal and external Windows junctions unavailable and
out of search. The note and bookmark watchers, embedded WebP, and 6,000-note search smoke
tests passed on the same build. Discovery of new files and stable identity across renames
remain open.

On 2026-11-06, on Windows build 19045 with the working tree based on `7929380`, full Rust
refresh began using a read-only inventory of visible files. The scan includes nested Unicode
paths and Archive and skips dot entries, links, and initialization backups. Indexed Trash
items retain their separate contained read path. Watcher refreshes still use the changed paths.
All 17 Rust tests and 11 targeted Electron Obsidian and path tests passed. The Windows release
preview passed the junction, note watcher, bookmark watcher, and 6,000-note search smoke tests.
The scan does not add new items to the library yet. Identity matching, empty folder discovery,
and full-refresh performance measurement remain open.

On 2026-11-06, the Windows release preview built from the working tree based on `7929380`
bound Rust refresh requests and watcher events to their vault session. A smoke test reopened
the same disposable bookmark vault to create a second session. The superseded session returned
no updates, and the active one received the changed bookmark. The note watcher, bookmark watcher,
and 6,000-note search smoke tests also passed. All 17 Rust tests and `pnpm typecheck` passed.
Rename identity and switching between different vaults through the native picker remain open.

On 2026-11-06, the Windows release preview preserved the indexed note ID and body after a
case-only rename, updated the title and path in the workspace, and kept search and overview
on the same revision after reload. All 18 Rust tests, TypeScript checks, and the rename,
junction, note watcher, bookmark watcher, and 6,000-note search smoke tests passed.
Renames that change the name or move the item to a different folder still need identity matching.

The Electron baseline passed 49 targeted autosave, capture, Obsidian, path, and transaction
tests, including termination during commit and rollback. These checks exercise the current
Electron write path. The Tauri preview still keeps edits in memory.

On 2026-11-06, Rust began reconciling same-folder Markdown renames when the old path is
missing and exactly one unclaimed file matches the note's known bytes. Existing paths retain
their IDs, and duplicate candidates stay unresolved. The note detail, search, and native Reveal
use the reconciled path. All 19 Rust tests passed, including duplicate handling and Reveal.
The Windows release preserved the note's ID, body, title, and search result after a same-folder
rename and reload. The case-only rename, junction, note watcher, bookmark watcher, and
6,000-note search smoke tests passed on the same build.
Cross-folder moves, renames with simultaneous edits, and identity recovery from hidden records
remain open.

On 2026-11-07, same-folder Markdown rename reconciliation began preferring an unambiguous
filesystem identity over content matching. Rust reads identity from the open file during refresh
or from a validated schema-v2 note record when reopening. All 20 Rust tests passed, including
a rename with edited contents and a second file that still matched the old fingerprint.
The Windows release smoke test used an Electron-format identity from Node's file stat on a
disposable vault copy and verified the same note ID, edited body, title, and search after reload.
Six other release smoke tests passed for renames, junctions, watchers, and 6,000-note search.

Later on 2026-11-07, a Windows release smoke test moved an attachment-free note to an
indexed collection. The preview updated its folder and title and preserved the ID, edited
body, and search result after reload. The seven other Windows smoke tests, 21 Rust tests,
and TypeScript checks passed. The Rust tests include a move whose removal and arrival were
reported in separate watcher batches. Moves involving attachments or newly created folders,
new item discovery, and removal of the snapshot adapter remain open.

Rename reconciliation now reserves the current paths of indexed notes. A note can be renamed
back to its original filename during the same session without losing its ID or native Reveal
target. All 21 Rust tests passed, including the rename round trip and existing duplicate checks.
Phase 3 remains open.

On 2026-11-07, the Windows release built from the working tree based on `7929380` reopened
schema-v2 item and collection records when the startup index was absent, corrupt, or belonged
to another vault. The tracked `scripts/smoke-tauri-record-recovery.cjs` created its own vault
and WebView2 profile and verified exact Markdown, collection identity, search, parsed bookmarks,
PDF bytes, and note identity after a rename with an external edit and a reload. Recovery left
visible files, records, and the invalid cache unchanged. All 26 Rust tests passed, including
saved attachment reads, malformed records, duplicate paths, missing content, lifecycle locations,
and Windows junctions.
Vault reads now run on a blocking worker rather than the async command executor. This recovery
uses existing records; new file and folder discovery, live attachment reconciliation, and removal
of the production snapshot adapter still keep Phase 3 open.

The release also passed the existing 6,000-note search and embedded-image smoke tests.
`pnpm check` passed, including 440 app tests, lint, type checks, builds, and performance budgets;
`pnpm audit --prod` reported no known vulnerabilities. The first lint run included disposable
scripts under `.performance`; that generated directory is now excluded, while the tracked
recovery smoke remains linted. Rust Clippy was unavailable in the installed toolchain.
