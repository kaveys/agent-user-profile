# Contributing

Thanks for looking. This project is small on purpose: one storage CLI, one host plugin, one hand-written panel. Keep it that way.

## Ground rules

1. **No build step.** `client.js` is written directly against `window.__ModuleLoader__` and `React.createElement`. No JSX, no bundler, no new dependencies.
2. **The CLI is the portable core.** Anything that touches the portrait files belongs in `bin/profile.mjs`, not in `index.js`. A host adapter should only translate events.
3. **No host client packages.** Do not `require('@deepseek-ai/dsh-client-ui-*')` from `client.js`; colour with `--dsw-alias-*` variables only.
4. **Every mutation rebuilds.** If you add a command that changes portrait data, end it with `rebuildQuietly()` and snapshot first when it can lose data.
5. **No silent data loss.** Refuse the operation and explain, or snapshot and proceed — never drop entries because a dimension lookup failed.

## Before opening a PR

```bash
node --check index.js && node --check client.js && node --check bin/profile.mjs
node _selftest.mjs
node _e2e.mjs          # starts its own temp HOME; the HTTP part needs a running DSH
node _audit.mjs
node _render.mjs
node scripts/verify-install.mjs
```

All five must be green. If you change rendered text in the panel, update `_render.mjs` assertions in the same commit — they exist precisely because `node --check` cannot see a broken `map()`.

## Adding a dimension

Built-in categories are in `DIMENSIONS` (`bin/profile.mjs`) and mirrored by `DIMENSION_GUIDE` in `index.js` so the extractor's prompt stays in sync. Adding a category means:

1. add it to `DIMENSIONS` with a label and a hint;
2. add the same hint to `DIMENSION_GUIDE`;
3. bump `DEFAULT_CONFIG.schemaVersion`;
4. add a migration branch if old entries need reclassification;
5. add a `_selftest.mjs` case.

## Commit messages

Conventional-ish, one line, English, imperative: `fix: clamp fact length on declare`, `feat: restore points for portrait data`.

## Reporting a bug

Include: what you did, what you expected, what happened, and the output of

```bash
node bin/profile.mjs status
node bin/profile.mjs panel
```

Redact portrait text if it is personal.
