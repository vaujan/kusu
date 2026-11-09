# Current Architecture

Status: Current

This document describes where the application stands now. Historical decisions and superseded
approaches remain in `05-technical-decisions.md`.

## Runtime boundaries

Kusu is one Electron application with three code environments:

- `src/main/`: trusted native process; owns filesystem, windows, network access, and persistence.
- `src/preload/`: narrow typed adapter between Electron IPC and renderer APIs.
- `src/renderer/`: sandboxed React interface with no Node or arbitrary filesystem access.
- `src/shared/`: data-only contracts and pure logic shared across process boundaries.

Renderer operations use validated item, collection, submission, and attachment IDs. The main process
resolves every native path and validates all IPC input at the trust boundary.

## Main process

### Application lifecycle

`src/main/index.ts` creates the singleton application services, windows, shortcut controller, and IPC
registrations. Window-specific behavior belongs under `src/main/window/`.

### Library application service

`src/main/library/library-service.ts` is the concrete application facade. It owns the active-library
state, validation and policy decisions, reconciliation scheduling, URL enrichment coordination, and
operations exposed to IPC.

### Vault persistence

`src/main/library/storage/library-store.ts` owns schema-v2 vault persistence, scanning, records,
reconciliation, capture staging, collection filesystem operations, and item lifecycle transactions.
It is being separated incrementally along those existing responsibilities; path containment remains
one shared security boundary.

`src/main/library/storage/json-file.ts` owns atomic JSON writes. Item parsing and metadata derivation
belong under `src/main/library/items/`.

`src/main/library/storage/note-file.ts` owns note-content replacement. It flushes a uniquely staged
file under `.kuskus/temp`, then renames it over the destination without first moving the original.
An interrupted process therefore leaves the old or new complete note at its visible path. Metadata
is updated afterward and remains reconcilable from visible content. This does not establish
power-loss durability on every filesystem.

`src/main/library/storage/vault-transaction.ts` owns persisted undo journals for item/folder moves,
renames, reference rewrites, and associated metadata changes. Each undo action is flushed before
its mutation; commit is persisted after the complete operation. Opening/scanning a vault recovers
uncommitted operations before indexing. Transactions serialize within one process; conflicts stop
recovery and retain the journal. This does not coordinate external editors or certify power-loss safety.

### Capture

`CaptureSessionService` persists the current shared draft and ownership revision.
`CaptureSubmissionService` turns accepted drafts into a durable FIFO queue and commits them through
`LibraryService`. Capture submission records and staged bytes remain recoverable before finalization.

### IPC

Handlers under `src/main/ipc/` translate unknown IPC values into validated service calls and
`ApiResult` responses. They do not contain filesystem policy. Channels and DTOs are declared under
`src/shared/` and implemented by the preload bridge.

## Renderer

### Application entry

`App.tsx` loads the bounded library overview and chooses setup or workspace presentation. Optional
heavy surfaces such as item detail and capture editing use lazy imports.

### Workspace

`features/library/workspace.tsx` is the renderer composition root. Feature behavior is moving into
focused modules while Workspace retains cross-feature coordination.

Current extracted retrieval ownership lives in `use-library-retrieval.ts`:

- main-process full-text query IDs
- request race protection
- destination and folder scope
- type and referenced-attachment filters
- sorting

Full-text search is authoritative in the main process because renderer overviews contain truncated
note bodies.
The Electron main process calls a Rust Node-API addon to scan and rank search results on a libuv
worker. Each query uses the index snapshot for its library revision. Search text is held only while
queries are active and for a short period afterward. The preload contract and React views are shared
across the desktop builds.

### Feature ownership

- `features/capture/`: composer, quick capture, shared session, staging, and recovery UI.
- `features/collections/`: folder trees, folder dialogs, icons, and drag payloads.
- `features/items/`: cards, detail/editor surfaces, Markdown behavior, previews, and item shortcuts.
- `features/library/`: workspace retrieval, layouts, selection, and bulk library interactions.
- `features/shell/`: toolbar, sidebar, toaster, caption controls, and application shell composition.
- `components/ui/`: local shadcn/Base UI primitives only; no application policy.
- `hooks/`: renderer-wide platform preferences such as theme, zoom, and translucency.
- `lib/`: small shared renderer services such as notifications and window-material control.

## Vault flow

1. Main process reads the selected vault's schema-v2 library record.
2. Scanner ignores hidden folders, does not follow filesystem links, and indexes supported visible
   files and ordinary folders.
3. Stable hidden records reconcile by path, filesystem identity, then unique fingerprint.
4. A bounded rebuildable overview is sent to the renderer.
5. Exact note content is loaded by item ID when required.
6. Filesystem watch/focus reconciliation updates the snapshot and notifies renderer windows.

Visible files and folders remain authoritative. `.kuskus` records and indexes preserve identity,
recovery, and performance but are never the only readable content copy.

## Capture flow

1. A main or Quick Capture surface claims the current library's draft session.
2. Text and staged asset revisions persist through the typed capture API.
3. Submit validates the expected revision and writes a durable submission record.
4. The queue commits submissions in FIFO order through `LibraryService`.
5. Finalization writes attachments/records first and the note or item last.
6. Success clears the corresponding staged state; failure remains retryable or discardable.

## Adding code

- Filesystem or network behavior: main process.
- New cross-process operation: shared contract, preload adapter, IPC validation, then service method.
- Vault policy: `LibraryService`.
- Filesystem mechanics: storage module.
- Pure item parsing/derivation: item module.
- User workflow: owning renderer feature.
- Reusable primitive styling: `components/ui` only when it has no application policy.

Prefer an existing concrete module over a new interface, provider, registry, or event system. Split a
module when a working responsibility can move with its tests, not to satisfy a line-count target.

## Required checks

Before merge:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm perf:budget
```

Storage changes must retain temporary-vault transaction and recovery tests. Renderer performance
changes must preserve separate main and Quick Capture dependency graphs.
