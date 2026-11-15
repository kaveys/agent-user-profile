# Changelog

All notable changes to `agent-user-profile` (package name `dsh-user-profile`).
The portrait schema version is tracked separately and lives in `config.json`.

## Unreleased

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
- `_e2e.mjs`: 35 checks across every CLI command and every HTTP action, including three error branches.
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
