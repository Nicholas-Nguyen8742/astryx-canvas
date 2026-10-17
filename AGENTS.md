# AGENTS

Project-specific guidance for AI coding agents.

<!-- ASTRYX:START -->
Astryx v0.7.1 · 168 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx template <Block>` for parts it lacks; `astryx component <Name>` to read props before using one.
Changing an existing page? Keep it: skip step 2 and add blocks/components inside its sections.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then tokens (var(--color-*|--spacing-*|--radius-*)). No raw hex/px. No StyleX/Tailwind compiler here — don't use xstyle/utility classes directly. Some templates use StyleX and need a compiler plugin; see `astryx docs styling-overview`.
- Palettes and custom colors go through the theme, never :root overrides. Run `astryx theme add <slug>` to import; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or a token.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands, API reference, integration authoring
  upgrade --from <old version> --apply   run after a dependency bump
<!-- ASTRYX:END -->

## Project conventions

Everything below this marker is hand-maintained and survives `astryx init`
regeneration. It records working agreements that cannot be derived from reading
the code.

### Committing

"Commit like before" means:

- **Conventional commit** messages (`feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, `chore:`), scope in parentheses where it helps.
- **Split into several commits by logical concern**, not one lump.
- **Order them so every commit leaves a green tree** — typecheck and tests pass
  at each commit, not just at the tip. History is meant to be bisectable.
- Commit as the already-configured local git user. Never change git config.
- **Never `git push`.** It is not authorised. An external process already
  advances `origin/main` between sessions, so do not assume `HEAD` equals
  `origin/main`, and do not treat a diverged remote as something to reconcile.

When claiming a commit is green, verify it rather than reasoning about it: once
the tree is clean, check the commit out in a detached HEAD, run the gates, then
return to `main`.

### Git housekeeping — deliberate inaction

`git` warns `There are too many unreachable loose objects; run 'git prune'` on
every operation. **Do not act on it.** As of 2026-10-16 the repo holds ~16,000
loose objects against 28 reachable commits, with no stashes, only two refs,
`garbage: 0` and `prune-packable: 0` — nothing is corrupt.

`gc.pruneExpire` is unset, so `git gc` would consolidate the packs but prune
nothing recent, and would *not* clear the warning. Only `git prune` clears it,
by irreversibly discarding recent objects that no ref protects and that may be
the sole copy of abandoned work. This is the owner's decision, not an agent's.

### Verification bar

Three gates, all of which must pass before reporting work complete:

```
npm run typecheck   # tsc over both the node and web projects
npm test            # vitest unit suite, node environment, no DOM
npm run test:e2e    # builds, then drives a real Electron window
```

The E2E suite is not redundant with the unit suite. It is the **only** layer
that has caught layout collapse (a canvas silently falling back to the 150px
replaced-element default) and lifecycle bugs (a `before-quit` handler that made
the app unquittable). Neither produced a compile error, a failed load, or a log
line. Do not downgrade a claim to "the UI probably renders" on the strength of a
passing typecheck.

Its final test asserts no `pageerror` and no console `error` across the whole
journey. A new failure there means something threw inside React, even when every
other test passed.

### Offline mandate

NFR-OFF-01/02. Nothing may reach the network at runtime, including fonts and
CDN assets. When touching styles or dependencies, prove it by grepping the
*built* output in `out/` for remote origins rather than trusting the source —
a transitive `@import` will not show up in the files you edited.

### Environment gotchas

- A **formatter hook rewrites files on every write** (double quotes, 4-space CSS
  indent, reflowed long lines). An `edit` whose `old_string` was captured before
  a neighbouring write will fail to match. Re-read before editing.
- The agent **memory store is broken** in this environment: every write to
  `~/.qwen/memories` or the project memory directory fails with
  `Internal error (cause: -32603)`, on both flat and nested paths. This file and
  `docs/TRD-DEVIATIONS.md` are the durable record instead. Do not keep retrying
  the tool.
- `docs/TRD-DEVIATIONS.md` records every place the implementation departs from
  the TRD, including requirements deliberately deferred. Read it before assuming
  a TRD clause is unimplemented by oversight — several are intentional and
  justified there.

