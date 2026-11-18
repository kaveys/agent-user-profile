# Changelog

All notable changes to `agent-user-profile` (package name `dsh-user-profile`).
The portrait schema version is tracked separately and lives in `config.json`.

## Unreleased

### v26.1 — intro video refreshed (88.9s, one new scene)

#### Changed
- Trailer gains a scene「它会自己整理」: duplicates that mean the same thing merge into one entry, and a portrait can be imported wholesale from another AI tool (`ingest`). Eight scenes, 88.9 s, same Kokoro voice; `agent-user-profile.srt` and `-narration.txt` regenerated, README duration updated 77 → 89 s.
- `scripts/build-trailer.ps1`: the new scene's inline subtitle no longer repeats the caption band verbatim (it now reads「记得越多，越要会整理」).

### v19 — host compatibility layer (capability probe + degradation + doctor)

Plugin version bumped to **0.3.0**. package.json gains dsh.compat = { hosts: ">=0.2.0", strategy: "capability-probe" }.

#### Added
- **Capability probe**: index.js inspects every host API it uses (session/event, agent/pre-step, webServer, connection, llm, loader) and writes the result to $DSH_USER_PROFILE_HOME/.host.json (no credentials, rewritten only on change).
- **profile doctor / doctor --json**: turns that file into "available / missing → what it costs you", and prints the next step when the host has never written it.
- **Event name aliases**: tool_call / tool-call / tool/call (and friends) are normalised before dispatch, so an older host's event names are not dropped as junk.
- **Single startup line when degraded**: only the capabilities actually missing are listed.

#### Fixed
- **Paths frozen at module load**: cached(p('inject.md'), ...) captured DSH_USER_PROFILE_HOME at import time, so changing the data directory (tests, profile switching, MCP process reuse) still injected the previous user's portrait. All four readers (inject.md, profile.md, config.json, profile.json) now resolve the path per call and cache per final path.
- **export const inject = ['loader'] was a hard dependency**: hosts without loader refused to load the plugin at all. Now [], with runtime detection.
- **Client apply threw without slots**: hosts lacking settings.section lost the whole settings page instead of one tab. Now guarded; inject no longer declares slots.
- tests/render.mjs assertion that froze the old inject = ['slots'] contract.

#### Tests
- New tests/compat.mjs (11 checks) and tests/audit-4.mjs (22 checks); both wired into scripts/register.mjs and CI.
- Full suite: selftest, audit 33, audit2 34, audit3 51, audit4 22, compat 11, render, e2e --cli-only 26, verify-install 13, node --check 13 files.



### v17 — reorganised around a six-step memory pipeline

### Added
- **Trigger gate**: one-off work (translation, homework, "what does this error mean") is no longer mined for preferences; a turn is only distilled when the user talks about themselves. `extract.skipEphemeralTurns` (default on).
- **Hard privacy blocks**: national ID, bank card, password and precise address are rejected outright instead of being masked — "he has an ID number" is risk without portrait value. `--force` overrides; masking still applies afterwards.
- **Three partitions**: every dimension maps to `user_profile` / `user_preference` / `user_social_network`; `panel` reports `partitions` and each item carries `partition`.
- **Relevance gate**: before injection, non-redline items are filtered by character-bigram overlap with the current turn; redlines always come through, and the count of dropped items is stated in the block. `inject.relevantOnly` (default on, editable in Settings and via `set`).
- **Encrypted backups**: AES-256-GCM (scrypt-derived key) for `backup --encrypt` and by default for WebDAV uploads; new `unseal` command turns a sealed package back into importable JSON.

### Fixed
- `inject.maxChars = 0` (the "no cap" convention) was treated as a zero-length budget, truncating the whole portrait to a single ellipsis line.
- The relevance gate dropped the `# 用户画像 vN` title and its `> 生成于 …` line, leaving the injected block unattributable.
- `inject.relevantOnly` was missing from `SET_SPEC` and the panel settings payload, so it could not be changed.

### v15 — quality gates instead of size caps

### Added
- **MCP server** (`mcp/server.mjs`): stdio JSON-RPC 2.0, zero dependencies, 10 tools (`profile_get/status/search/declare/forget/set_weight/review/validate/backup/set`) and 2 resources (`user-profile://portrait`, `user-profile://declarations`). Thin wrappers over the CLI, so MCP and CLI can never diverge. stdout carries protocol only; logs go to stderr.
- **Redaction presets** applied *before* writing: phone, email, national ID, secrets (`sk-`/`ghp_`/`github_pat_`/`AKIA`/`xox?-`). Hits are reported in the receipt; stored text never contains the raw value.
- **`profile redact`**: scan-only by default (`N entries, M hits`), `--apply` rewrites after taking a snapshot.
- **Provenance** on every declared entry: `{kind, at, session, turn, excerpt}`; surfaced in `profile show`, `panel` (`items[].provenance`, `pending[].provenance`) and the panel's item subline.
- **`profile validate`**: reports entries that fail the validity gate; `--quarantine` moves them to `invalid-<ts>.jsonl` (snapshot first).
- **WebDAV backup**: `backup` uploads, `--list`, `--pull <name>`, `--dry-run`, `--out <dir|file>` (local, no network). Password read from `DSH_PROFILE_WEBDAV_PASSWORD` or `secrets.json` — never written to config or into the backup bundle.
- Panel: “体检 · 脱敏 · 云端备份” section, a yellow data-warning banner, and a “云端备份（WebDAV）” settings group.

### Changed
- **No size caps by default**: `inject.maxChars=0` and `inject.topK=0` (0 = unlimited). Volume is controlled by the gate, not by truncation.
- **Injection budget is a single absolute pool, first-write-first-served** (constraints → personalisation → background). The old per-section percentage caps are gone — they let hard constraints be cut before background notes.
- **Default entry key** is `${dim}.${factKey(fact)}` (djb2 fingerprint) instead of the dimension name, so a second entry in the same dimension no longer overwrites the first.

### Fixed
- **Silent data loss in `readJsonl`.** Malformed lines were skipped without a word. They are now quarantined to `<file>.bad-<date>`, the good lines are rewritten atomically, and the incident is reported via `warnings` (panel banner + `status`).
- **Busy-wait lock.** `withLock` spun on `Date.now()` (up to 10 s of full CPU). It now sleeps via `Atomics.wait`.
- **Lock could be stolen from a live holder.** The timestamp was written in a second step (`openSync` → `writeFileSync`), so a concurrent process could read an empty file, treat it as a 60 s-old stale lock and delete it — two writers, one lock, lost entries. The stamp is now written through the same descriptor that creates the file, and an unreadable stamp is treated as “just created”, never as stale.
- **Project-scoped entries were rejected by the global gate.** The “this looks like a one-off task detail” rule now only applies to `scope=global`.

### Fixed
- **Config corruption was silent.** A malformed `config.json` used to be swallowed and replaced by defaults in memory, then overwritten on the next write — the user's settings disappeared without a word. Now the file is backed up to `config.json.corrupt-<ts>`, rebuilt from defaults, and the fact is reported by `profile status` and in the panel's `warnings`.
- **Portrait text could forge structure.** An entry containing `## heading`, a newline, or `<!--dsh-user-profile-->` could invent a new injection section or trip the "already injected" fingerprint. Rendering now sanitises every entry (`safeText`) while the stored text stays untouched.
- **Over-long facts were stored verbatim.** `declare` now clamps to 400 characters and says so in the receipt.
- **Default entry key was the dimension name**, so a second fact in the same dimension silently replaced the first. The default key is now a content fingerprint: the same sentence updates its entry, a different sentence creates its own.

## v13 — adversarial hardening

### Fixed
- Deleting a built-in dimension is refused (it used to succeed and then drop every entry in it from the portrait).
- Deleting a custom dimension that still owns entries is refused, with `dims move` as the way out; `dims move <from> <to>` is new.
- `set` validates 38 known keys (type, range, enum, dimension lists) and rejects unknown keys; `set list` prints the table.
- The host passed every setting through `JSON.stringify`, so numbers arrived as `"1600"` and would fail validation. Only arrays and objects are stringified now.
- Dimension lists accept both `a,b` and `["a","b"]`.

### Changed
- `set` no longer rebuilds by default (it used to create `profile.json` in a freshly initialised directory); pass `--rebuild` to apply immediately.

## v12 — admission gate and weights

### Added
- Three-question gate for extracted facts: does it survive a different task, does it change what I'd do next time, is it about the person rather than the task.
- `scope` on every entry (`global` / `project`); project-scoped facts never reach the portrait by default.
- Manual weight editing: `edit --weight`, plus `−` / `+` steppers and a number field in the panel.

## v11 — end-to-end verification

### Added
- `tests/e2e.mjs`: 35 checks across every CLI command and every HTTP action, including three error branches.
- Panel screenshots for all seven tabs.

## v10 — visual layer

### Changed
- Typography and spacing scale, cards with a 2px brand accent, sticky tabs with count pills, dismissible notices, skeleton loading, error cards.
- Batch delete now requires a second click; the receipt points at *Restore points*.
- Restore points collapse to five with an "expand all" toggle.

## v9 — restore points

### Added
- `snapshots` / `restore` commands, `snapshots/` retention (20), and the *Restore points* section in the panel.

### Fixed
- A leaked `.lock` file could block every later command; locks are released on `exit`.
- Forgetting an entry left the rendered portrait untouched (looked like a failed delete). Every mutating command now rebuilds.

## v8 — policy separated from data

### Changed
- Usage rules (priority order, personalization, opt-out) moved out of `inject.md` and the entries into the plugin's own `PLUGIN_POLICY`. The policy is injected even when the portrait is empty.

## v7 — personalization

### Added
- Three-section injection: red lines (40% budget) → personalization preferences (75%) → background.
- `priorityOnPersonalize`: when a turn looks like a style/taste/defaults request, the portrait becomes primary evidence rather than background.

## v6 — ten dimensions

### Changed
- Six flat dimensions replaced by ten top-level categories (identity, work, skills, habits, interests, taste, goals, social, constraints, communication) with `category.subkey` naming. Existing entries are reclassified and the original file is backed up.

## v5 — the panel only talks about the user

### Removed
- Storage paths, activity charts, tool mix, per-field config paths, and the generated "tool usage" entries.

## v4 — seven-tab panel

### Added
- Overview / entries / pending / conflicts & history / dimensions / settings / backup, plus twelve HTTP actions.

## v3 — CRUD

### Added
- `edit`, `merge`, `import`, `dims`, `review`, `forget --key/--dim/--all`, and the matching panel controls.

## v2 — weighted portrait

### Added
- Two-stage injection (core first, then top-K by weight), scopes, frozen conflicts, pending candidates.

## v1 — first working version

Hooks capture turn signals, the CLI aggregates them deterministically, and the plugin injects the portrait at the start of every turn with a per-turn opt-out.
