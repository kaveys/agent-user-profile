# agent-user-profile

**A "manual about you" for AI assistants.**

Every new chat starts the same way: you re-explain yourself — I'm a student, I like clean interfaces, don't touch my project folder, give me the conclusion first.
This plugin writes those things down, keeps them in one clear list, and puts that list in front of the assistant before every task. You don't have to repeat yourself.

If you don't want it for a turn, say "don't use my profile this time" — it steps aside and tells you so.

**[54-second intro (Chinese narration)](docs/video/agent-user-profile.mp4)** · [中文 README](README.md)

![Overview](docs/screenshots/01-overview.png)

## Why it exists

| Before | After |
|---|---|
| Re-introduce yourself in every new chat | It already knows, and starts in your style |
| Preferences fade after a few days | They live in a list you can edit and re-weight |
| It occasionally picks a style you dislike | The list says "clean, no flashy animation" and it follows |
| Worried the AI hoards your private details | Only conclusions are stored; raw chat never hits disk; ID numbers and passwords are refused |

## What it remembers

Four kinds, all of them "still true in a different task":

| Kind | Examples |
|---|---|
| **Who you are** | Undergraduate in UAV systems engineering; writes in Chinese |
| **What you like** | Clean layouts with whitespace; cool colour palette; no exclamation marks |
| **How you work** | Conclusion first, then reasoning; show evidence; make it actually run |
| **What you never want** | Don't touch my project files; don't delete anything unasked; redact before publishing |

Every entry can be edited, re-weighted, marked as a hard rule, or deleted — and deletions are undoable from the built-in snapshots.

## What it refuses to remember

- ID cards, bank cards, passwords, home addresses — refused outright, not masked.
- Details of the current task: file names, paths, ports, versions, stack traces, one-off requests.
- Raw conversation — the disk holds a list of conclusions only.
- Project-local preferences — they never leak into your general profile.

## Getting started

### Try it with nothing but Node

```bash
git clone https://github.com/kaveys/agent-user-profile.git
cd agent-user-profile
node bin/profile.mjs init
node bin/profile.mjs declare --dim taste --fact "用户偏爱克制的深色界面" --confidence 0.9
node bin/profile.mjs declare --dim constraints --fact "scrub everything before publishing" --core
node bin/profile.mjs declare --dim communication --fact "conclusion first, evidence second"
node bin/profile.mjs build && node bin/profile.mjs show
```

### Use it inside DeepSeek Harness

```bash
cp -r agent-user-profile ~/.dsh/plugins/dsh-user-profile
node ~/.dsh/plugins/dsh-user-profile/scripts/register.mjs
```

Restart the app once; a "用户画像" (user profile) section appears in Settings with seven tabs. The first run is empty on purpose — it won't invent things about you. Talk to it for a while, add entries yourself, or paste what another AI told you about you into "备份与重置 → 从别的 AI 搬回来" and it will classify, score and de-duplicate it.

### Share the same profile with other tools

```bash
node mcp/server.mjs
```

A standard MCP server — any MCP client can read the same profile.

## FAQ

**Does it phone home?** No. Data stays in `~/.dsh/user-profile/`. Uploading an encrypted backup to your own WebDAV is opt-in and off by default.

**Will it remember nonsense?** Three gates: only self-descriptions are extracted (translation, homework and error-hunting turns are skipped), unsure items wait for your approval, and near-duplicates are merged instead of piling up.

**Can I undo a deletion?** Yes — a snapshot is taken before every destructive action (last 20 kept), restorable from the panel.

**What if there is something it should know every single time?** **Pin** that entry. Pinned entries sit at the top of the injected block and skip the relevance filter — they are carried even into a turn about an unrelated compiler error. Pin from the row in the panel, or `node bin/profile.mjs pin --key <key>`.

**What if I want an entry to stop counting, without losing it?** Use **retire** (`node bin/profile.mjs retire`). The entry leaves the portrait and the prompt, but the record, its weight and its provenance stay in `declarations.jsonl`, so `profile unretire` restores it in one command. Retire means "not in play"; delete means "gone". Retired entries can be restored in bulk from the Data tab.

**Does any of it expire?** Two ways. Temporary state can carry its own shelf life — `node bin/profile.mjs declare --ttl 7d` (or `--expires 2026-12-31`) — and drops out of the portrait when it lapses, while the record stays on disk. Preferences have no hard deadline, but anything nobody mentions for months fades: it stops being injected automatically, the entry is still there, and the Data tab shows how many faded. Pinned entries never fade.

**Can a throwaway remark overwrite something I stated outright?** No. When two records describe the same thing, confidence decides first: a 1.0 instruction you gave will not be replaced by a 0.6 model guess — the guess is parked as *needs review* instead. If you do want newest-wins, `node bin/profile.mjs set conflicts.strategy newest` brings the old rule back.

**How big is it?** Tens of KB. No images, no chat logs.

**Do I need DeepSeek Harness?** No. The data layer is a standalone CLI, and the MCP server runs on its own.

## For developers

- [DESIGN.md](DESIGN.md) — design trade-offs and why the injection is layered
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — what degrades on older hosts
- [docs/POSITIONING.md](docs/POSITIONING.md) — how it differs from memory libraries, and how to port it
- [CONTRIBUTING.md](CONTRIBUTING.md) — house rules and the checks to run
- [SECURITY.md](SECURITY.md) — where data lives and the known boundaries
- [CHANGELOG.md](CHANGELOG.md) — what changed in every version, and why

Layout: `bin/profile.mjs` (data layer CLI), `lib/` (two pure-function modules for similarity and relevance), `index.js` (host-side capture + injection), `client.js` (settings UI), `mcp/server.mjs` (MCP surface). Zero dependencies, no build step.

```bash
node tests/selftest.mjs
node tests/audit-1.mjs
node tests/audit-10.mjs
node scripts/verify-install.mjs
```

## License

[MIT](LICENSE).
