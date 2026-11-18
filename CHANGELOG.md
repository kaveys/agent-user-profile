# Changelog

All notable changes to `agent-user-profile` (package name `dsh-user-profile`).
The portrait schema version is tracked separately and lives in `config.json`.

## Unreleased

### v33 — shorter narration, 54 s film

Every narrated scene was rewritten to say the same thing in fewer words: 398 characters → **253** (‑37%), one idea per sentence, no clause stacking. The film goes 95.1 s → **53.9 s** without dropping a single scene or touching the visuals.

#### Changed
- Narration, all ten spoken scenes. Examples: 「你说过，你喜欢简单一点。第二天，它又开始绕圈子。你说那个文件夹别动，它还是动了。每换一个新对话，你就得从头再讲一遍。」(60) → 「你说过喜欢简单点。第二天，它又开始绕。每换个对话，你都得重新交代一遍。」(30); 「那它和别的记忆插件差在哪。别的大多只存聊天记录，用的时候再翻。它把记忆整理成一张清单…」(70) → 「别人存聊天记录，用的时候再翻。它直接给你一张清单，开口前先读。」(28).
- Subtitles shortened to match (still a separate line from the narration, no duplication).
- Shorter sentences also fixed the ChatTTS pacing: all ten scenes landed at **4.7–5.3 字/秒 on the first take**, so the take-selection loop from v32 no longer rejects anything.
- `README.md` / `README.en.md`: 95 秒 → **54 秒** / `54-second`.

### v32 — the film shows pin and retire (95.1 s)

#### Changed
- New scene **`05c-keep` 「留下你真正在意的」**, between 「你说了算」 and 「它会自己整理」: the left card shows a pinned entry (`置顶` badge, 「不管这轮问什么，都先看到这一条」) with the one distinction people get wrong — **核心 = 更重要 · 置顶 = 每轮必带**; the right card shows `先放下` (soft retire) with 「不删，只是这轮不带上；随时拿回来」 and 「和删除的区别：记录一直留着」. Ten → **eleven** scenes, 85.3 s → **95.1 s**.
- **ChatTTS take selection.** The same script and the same seed can come out as 9 seconds or 18 seconds: pause length varies per generation (the 66-character first draft landed at 3.0 字/秒, the same text elsewhere measured 5.8). The build now synthesizes up to three takes and keeps the one whose pace is closest to **5.2 字/秒**, accepting anything in 4.6–5.9, then logs it as `[take N] Xs · Y 字/秒`. The scene's narration was also tightened from 66 to 55 characters.
- `README.md` / `README.en.md` durations follow the film (95 秒 / 95-second).

### v31 — state fields survive merging, batches take one snapshot

Every bug fixed here has the same shape: the command exits 0, the panel shows no error, and the only way to notice is to compare **what you just did** with **what the profile now contains**. `tests/audit-11.mjs` reproduces all eight as regression checks.

#### Fixed
- **Pin could disappear after an unrelated update.** `buildDimensions()` read `pinned` / `core` from the newest record of a key group only. Pin an entry, then let the model (or a second `declare`) write a fresher record under the same key, and the pin was gone. Both flags are now taken as the **union over the group**: you pin "this fact", not "this version of the string".
- **A new declaration could be merged into a retired record.** The write-path similarity merge did not skip `retiredAt` rows, so a fresh statement joined an entry that is not in the profile at all — the result was "I recorded it and the profile does not contain it", which is far harder to diagnose than a duplicate. Retired rows are no longer merge targets.
- **`merge` dropped the状态 of the record being merged in.** `merged = { ...keep }` inherited only the kept side: merging a pinned entry into an unpinned one silently unpinned it, and merging a live entry into a retired one made the live entry vanish. Both flags are now unioned, and the result stays live unless **both** sides were retired.
- **`dedupe --apply` did the same, and also scanned retired rows.** Group merging kept only the winner's `pinnedAt`, and retired records participated in clustering (so they could swallow live entries). The group's pin is now preserved, and retired records are excluded from the scan.
- **Injection budget could cut the two sections that must never be cut.** `pushSection()` applied the character budget to every section, so with a small `inject.maxChars` the pinned and red-line sections lost their entries while their headers stayed — a block that reads as "your profile is broken". Those two sections are now `mandatory`, and a section with no surviving entry emits no header at all.
- **`edit` had no snapshot.** A wrong edit could only be undone by hand from `changelog.jsonl`. It now stages a `declarations-edit-*` snapshot before writing.
- **Bulk panel actions cost one CLI call, one snapshot and one rebuild per row.** Twenty-five rows produced twenty-five snapshots, which rotated older restore points out of the 20-slot ring — the same mechanism that wiped profiles three times earlier in this project. Bulk `先放下` / `批量置顶` / `批量删除` / `设为核心` now send `--ids a,b,c` and do a single snapshot, single write, single rebuild.
- **An explicit `--key` was not an identity.** `declare --key taste.live` followed by `declare --key taste.old` with similar wording still merged across two deliberately distinct keys, keeping the first key and overwriting its text. Explicit, differing keys now block the similarity merge.

#### Changed
- `retire` / `unretire` / `pin` / `unpin` / `forget` accept `--ids a,b,c`; `edit --ids …` accepts state flags only (`--core`, `--weight`) and refuses `--fact`.
- `index.js` action handlers accept `ids` and pass `--dim` through for `unretire` / `unpin` (the CLI already supported it).
- Removed two dead duplicate implementations (`findMergeGroups`, `mergeGroupRecords`) left over from before the dedupe rewrite — they were never called, and a second copy of the merge rules is exactly how `explain` and injection drifted apart in v26.

### v30 — pinned entries, soft retire, before/after on edit

#### Added
- **`profile pin` / `unpin`**: a pinned entry gets its own injected section (`## 零、钉住（每轮必带）`) and is exempt from the relevance gate (`PINNED_SECTION` in `lib/relevance.mjs`), so it reaches the model every turn even when the current request has nothing to do with it. Distinction that matters: **core** is about priority within a turn, **pinned** is about presence in every turn.
- **`profile retire` / `unretire`**: soft invalidation. The entry leaves the profile but the record stays in `declarations.jsonl` with `retiredAt` / `retireReason`, so restoring it is one command instead of a snapshot rollback. `forget` is still the hard delete for "this never happened"; `retire` is "stop using this for now".
- Panel: `置顶` badge on the row, per-row `置顶` / `先放下` buttons, `批量置顶` / `先放下` in the selection bar, and a `失效条目 · N 条` section under 数据 with `全部恢复`. Breadcrumb counts (`stats.pinned` / `stats.retired`) are in the profile payload.
- MCP: `profile_retire` and `profile_pin` (14 tools now), so other hosts can pin and retire without the CLI.

#### Changed
- `profile edit` now prints a **before → after** line per changed field (内容 / 大类 / 键 / 权重 / 核心) instead of only the new value — otherwise there is no way to tell whether the edit landed the way you meant it.

#### Fixed
- `relevantOnly()` emitted **every section header twice**: once lazily when the first matching entry was kept, and once again on flush. Injected blocks therefore carried an empty duplicate such as a second `## 一、红线与硬要求`. The header is now written once per section, and only when that section actually has a surviving entry.

### v29 — a cover card opens the film (85.3s)

#### Added
- **`00-cover` scene**: 3.0 s title card —「DSH 新插件」chip,「人物画像」at 120 px, a short accent rule, then「让 AI 更懂你是谁」. No narration and no subtitle band, so it reads as a poster; because it is the first frame, the video's thumbnail is now the title instead of a mid-sentence still.
- `scripts/build-trailer.ps1` learned three small things to support it: a scene can be `Silent = $true` with a fixed `Hold` (a matching-length silent WAV is generated so every segment keeps the same stream layout), `HideBand = $true` skips the subtitle strip, and subtitle cues are numbered by their own counter so the cover does not leave an empty entry in the `.srt`.

#### Changed
- Nine scenes → **ten**; total **85.3 s**. README / README.en durations updated.

### v28 — sharper hook, a comparison scene, natural pace (82.2s)

#### Changed
- **Opening rewritten to hold attention**:「它读过整个互联网，却记不住你昨天说的一句话」at 70 px, with「换个对话，你又成了陌生人」as the third beat. The old opening described the problem; this one states the paradox, which is what makes someone keep watching.
- **New scene「和别的记忆插件，差在哪」** (nine scenes now): a two-column comparison — 别的记忆插件 `存聊天记录，用的时候翻出来 / 记你说过什么 / 删了就没了` versus 这个 `整理成一张清单，开口前先读 / 还记你是什么样的人 / 能改能删，删错能还原`. One claim per row, no feature lists.
- **Pace now sits at natural speech**: `-Tempo 1.0`, i.e. **5.1 字/秒** measured over the whole script (the 0.9 build ran 4.05–4.81 字/秒 and felt slow; 1.15 reached 5.9 字/秒 and read as rushed). Nine scenes, **82.2 s**.
- `01-hook` subtitle no longer repeats the headline（它记得全世界…）— it now closes the thought: 「不是它笨，是它不认识你」.

#### Fixed
- `scripts/build-trailer.ps1` silently reused stale artifacts: the scene PNG was only drawn `if (-not (Test-Path $png))`, and the per-scene MP4 was only encoded `if (-not (Test-Path $mp4))`. A copy change therefore left the old picture in the video while `tests/qa-frames.mjs` happily passed — it was measuring yesterday's frames.
  - PNGs are now redrawn on every run.
  - Narration files are cached under a SHA-256 fingerprint of `文案|引擎|音色|seed|tempo`, so editing a line forces a re-synthesis and an untouched scene stays cached.
  - Per-scene MP4s are always re-encoded.

### v27 — the voice finally sounds spoken (74.4s)

#### Changed
- Narration voice switched from Kokoro-82M to **ChatTTS**: a conversational model, so pitch, breath and pauses move the way a person talks instead of reading a script.
- Narration rewritten for the ear — shorter clauses, fewer parallel structures, spoken connectives（「你说过，你喜欢简单一点。第二天，它又开始绕圈子。」）. Same content, ~same length on screen.
- `scripts/tts_chattts.py` (new): ChatTTS engine; a seed *is* the voice (`torch.manual_seed` → `sample_random_speaker()`), so no embedding file has to be shipped and the same seed always renders the same voice. Seed **3** is the female narrator; 2 and 9 are the other female candidates.
- `scripts/tts.py` gains the `chattts` engine; `scripts/build-trailer.ps1` gains `-Engine chattts -Seed 3 -Tempo 0.9`（`atempo` slows ChatTTS down 10 % without changing pitch).
- Trailer: 8 scenes, **74.4 s**（was 88.9 s — ChatTTS speaks faster); `agent-user-profile.srt` and `-narration.txt` regenerated; README duration 89 → 74 s.
- `scripts/trailer-build/voice-audition.mp3`（gitignored）holds the same line read by five voices for A/B listening: chattts seed3 / seed2 / edge Xiaoxiao / edge Xiaoyi / kokoro.

#### Notes
- ChatTTS is not a dependency of the plugin: it only matters when regenerating the trailer（`pip install ChatTTS vocos vector_quantize_pytorch`）, and `HF_ENDPOINT=https://hf-mirror.com` helps when huggingface.co is unreachable.

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
