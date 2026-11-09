# Versioning and release notes

Kusu uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and curated notes based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions identify distributed desktop
builds. A beta label communicates release maturity; it does not relax data-safety requirements.

## Sources of truth

| Value                  | Owner                               | Rule                                                  |
| ---------------------- | ----------------------------------- | ----------------------------------------------------- |
| Desktop version        | Root `package.json`                 | Canonical SemVer, without `v` or build metadata       |
| Release notes          | `releases/notes.json`               | One unreleased entry and descending versioned entries |
| Human changelog        | `CHANGELOG.md`                      | Generated; never edit directly                        |
| Git tag                | `v` plus desktop version            | Tag the exact verified release commit                 |
| Installer version/name | electron-builder reads root package | Never override independently                          |
| Website deployment     | Git commit and hosting deployment   | Independent of desktop versions                       |
| Vault schema version   | Storage contracts                   | Independent of product releases                       |

The private website package's version is package metadata, not a second Kusu product version.
Keep the existing `0.0.x` history intact. The next intended desktop milestone is `0.1.0-beta.1`;
adding this policy does not prepare or publish that release.

## Choosing the next version

| Change                                         | Example                                      |
| ---------------------------------------------- | -------------------------------------------- |
| First tester build                             | `0.1.0-beta.1`                               |
| Revised tester build                           | `0.1.0-beta.2`                               |
| Feature-complete release candidate             | `0.1.0-rc.1`                                 |
| Completed release                              | `0.1.0`                                      |
| Compatible bug fix                             | `0.1.1`                                      |
| New features during initial development        | `0.2.0`                                      |
| Breaking workflow or storage change before 1.0 | Next minor version, with an explicit warning |
| Established stable product contract            | `1.0.0`                                      |

Supported prerelease labels are `alpha.N`, `beta.N`, and `rc.N`, starting at 1. New binaries with
changed code always get a new version, including fixes to a beta. Never overwrite a distributed
version, reuse its tag, or silently change its notes. Correct factual errors explicitly.

After 1.0, incompatible changes to documented file formats, supported integrations, or other public
contracts require a major increment; compatible features use minor and compatible fixes use patch.
Normal UI adjustments alone do not imply a major release. No version number makes an old vault
safe to open after an incompatible schema change: describe the supported format and required user
action explicitly. Do not add compatibility paths or automatic migrations to satisfy versioning.

## During development

Edit only `unreleased` in `releases/notes.json`. Group concise, user-facing Markdown strings under
`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, or `Performance`. Omit empty
categories. An optional single-line `summary` describes the milestone. Mention breaking changes
and required user actions plainly under `Changed` or `Removed`; do not expose private vulnerability
details before coordinated disclosure.

```json
{
  "changes": {
    "Fixed": ["Keep the original note available until its replacement is ready."]
  }
}
```

Run `pnpm changelog:generate` after editing notes. `pnpm version:check` validates versions, real
calendar dates, note categories, descending history, package/notes agreement, and generated Markdown.
It runs at the start of `pnpm check`, including in CI. Do not hand-edit `CHANGELOG.md` or bump only
the package with `pnpm version`.

## Prepare a candidate

After reviewing the intended changes, run from the repository root:

```bash
pnpm release:prepare 0.1.0-beta.1 2026-10-23
pnpm check
pnpm audit:all
```

Choose the actual preparation date in Asia/Jayapura, in `YYYY-MM-DD` format; the example is not an
automatic date. The command validates first, rejects non-increasing versions and existing local
tags, moves unreleased notes into a dated version entry, clears unreleased notes, updates the root
package version, and generates the changelog. Review the three changed files together and commit
them. If interrupted while writing those files, inspect their diff and restore consistency before
continuing; `version:check` catches mismatches. No tag, commit, build, or publication occurs.

Candidate entries are preparation records, not proof of publication. Keep their date as the
preparation date; GitHub records the actual publication time. Adding a release entry must never
make a website display a download or claim availability automatically.

## Verify and publish

`pnpm release:verify` additionally requires empty unreleased notes and a clean committed working
tree. `pnpm release` runs this gate before the full checks, full dependency audit, and signed Windows
packaging. Follow [the release process](15-release-process.md) for package inspection, native
testing, signatures, checksums, and corresponding source access.

Before creating a tag, fetch and inspect remote tags and confirm `v<version>` is unused. Local
validation cannot establish remote tag state. After native verification, tag the exact source
commit as `v<version>` and attach that version's artifacts to its GitHub release. Mark alpha, beta,
and rc releases as prereleases. Never tag an unverified installer or move a published tag.

If a candidate changes after it has been shared, prepare a new prerelease version with new notes.
Do not substitute a new artifact under the old number. Promotion from beta/rc to a normal version
also requires a new build and verification, with a release summary even when there are no code
changes. Signed packaging is not automatic publication.

## Release notes and update feeds

The future website or app page should consume `releases/notes.json`, rather than parse Markdown
or maintain another copy of the notes. Each release has `version`, `date`, and `notes`; notes
contain optional `summary` and categorized `changes`. Use the version to derive a GitHub release
link. Confirm publication separately before showing a download, filter prereleases according to
the selected channel, and exclude `unreleased` from public release lists.

Treat note strings as Markdown with raw HTML disabled. Installed Windows builds use
electron-updater to check their stable or experimental preview channel and download
updates at the user’s request. The updater uses its own channel manifest.
Structured release notes can be prepared before installers are available.
