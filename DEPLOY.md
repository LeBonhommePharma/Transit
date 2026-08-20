# Deploying `/transit`

`https://thebonhomme.com/transit/` is served by **GitHub Pages from the apex
repo** [`LeBonhommePharma/lebonhommepharma.github.io`], not from this repo.
That repo serves 82 routes from its `main` branch (`build_type: workflow`,
`source: {branch: main, path: /}`). `/transit` is one directory inside it.

Before this pipeline existed, publishing was a human running `cp` — see apex
commit `d1a6c2a` *"Refresh /transit from Transit main"*. Nothing verified the
result, so on 2026-08-19 the site served a build two commits stale
(23,930 B `index.html` against 39,320 B on `main`) while `main` looked green.

## What gets published

The published tree is composed from **this** repo. `scripts/publish-transit.mjs`
is the single definition of that composition:

| source (this repo)     | published as        |
| ---------------------- | ------------------- |
| `public/Transit/*`      | `transit/*`         |
| `public/data/`          | `transit/data/`     |
| `public/l10n/`          | `transit/l10n/`     |
| `public/favicon.svg`    | `transit/favicon.svg` |
| — (apex-local, preserved) | `transit/README.md` |

`public/data/` (39 MB GTFS atlas) is **tracked in git**, so publishing needs no
GTFS ingest, no `.cache/`, and no feed credentials. Do not add a re-ingest step.

The Next.js app is **not** published. `next build` output never reaches the site.

## The mechanism

```
push to main (this repo)
   └─ .github/workflows/deploy.yml
        Gate A  npm test          162/162
        Gate B  compose + verify artifact
        └─ repository_dispatch ─────────────┐   (needs APEX_DISPATCH_TOKEN)
                                            ▼
apex .github/workflows/publish-transit.yml  ◀── also: */15 cron, workflow_dispatch
        Gate A  npm test on the Transit checkout
        Gate B  compose + stamp + verify artifact
        rsync --delete into transit/ only, commit, push to apex main
   └─ apex .github/workflows/pages.yml deploys the whole site
        Gate C  fetch the live URL, assert served bytes == built bytes
        Gate D  assert the other routes still return 200
        on failure: automatic git revert + push  (rollback)
```

The engine lives in the apex repo on purpose: a workflow's `GITHUB_TOKEN` is
scoped to its own repository, so this repo cannot push to the apex repo. This
repo is public, so the apex repo reads it with **no credential at all**. The
pipeline is therefore token-free except for the optional instant trigger.

## Verification — why a green run means "live"

Gate B injects a stamp into `index.html` and `watch.html` at build time:

```html
<meta name="build-sha" content="<40-char Transit commit sha>" />
```

Gate C then fetches `https://thebonhomme.com/transit/` with a cache-busting
query and `no-cache`, and requires **both**:

1. the served body contains that exact `build-sha`, and
2. `sha256(served bytes) == sha256(built index.html)`.

It polls every 15 s for up to 15 minutes to absorb Fastly propagation
(`/transit/` is `cache-control: max-age=600`). If it never matches, the run
goes **red** and the publish is rolled back. A green run means the bytes were
verified live, not merely pushed.

Gate D additionally re-checks `/`, `/benchmark/`, `/shannon/`, `/periodic/`,
`/FlexAIDdS/`, `/drug-of-the-day/` and `/interaction.css` so a `/transit`
publish cannot silently take down the other 81 routes.

## Why the gate is `npm test` and not `npm run build`

`npm run build` is **red on `main`** — 10 pre-existing TypeScript errors:
nine in `src/lib/*.test.ts` and one in `src/lib/webgpu.ts` (`TS2722`). They are
not introduced by this pipeline, they are **not fixed** here, and they are
**not suppressed** — no `|| true` anywhere.

They are simply not a gate on this deploy, because `next build` output is not
what gets published. The meaningful gate is `npm test`:

- it is fully green — 162 tests, 49 suites, 0 failures;
- it imports the **shipped static modules directly** (`src/lib/rive.test.ts`
  imports `../../public/Transit/rive-kit.js` and `bikes.js`), so it exercises
  the exact bytes the workflow publishes.

Gate B adds artifact integrity on top: every shipped `.json` must parse,
`index.html` must exceed 30 KB, must carry the build stamp, must contain the
markers `tool-status`, `load-err`, `class="cities panel"`, `--metro-edge`, and
must **not** contain the superseded `role="tablist"` or `#0f172a`.

To make `next build` a gate, fix those 10 errors and add the step. Do not add
it with `|| true`.

## Publishing

- **Automatic** — push to `main`. With `APEX_DISPATCH_TOKEN` set it publishes
  immediately; without it, the apex `*/15` cron publishes within 15 minutes.
- **Manual, immediate** — apex repo → Actions → **Publish /transit** → Run
  workflow. Optional `ref` input publishes any Transit commit or branch.
- **Dry run** — same, with `dry_run: true`. Builds and runs Gates A and B, and
  commits nothing.

The workflow is idempotent: if the composed tree already equals `transit/`, it
records "already in sync" and exits green without a commit. Re-running is safe.
`concurrency: publish-transit` with `cancel-in-progress: false` prevents two
publishes interleaving, and lets an in-flight one finish or roll itself back.

## Rollback

**Automatic.** If Gate C or D fails, the workflow reverts its own publish commit
and pushes, restoring the previous `transit/`. The run stays red.

**Manual.** Every publish is one commit in the apex repo touching only
`transit/`, so reverting is a one-liner:

```sh
cd ~/Projects/lebonhommepharma.github.io
git log --oneline -- transit          # find the bad publish
git revert --no-edit <sha>
git push origin main                   # pages.yml redeploys
```

**Republish a known-good source commit** instead of reverting — apex Actions →
Publish /transit → Run workflow → `ref: <good Transit sha>`.

## When it fails

| symptom | cause | action |
| --- | --- | --- |
| Gate A red | a real test regression | fix the test; nothing was published |
| Gate B red on a marker | `index.html` changed intentionally | update `REQUIRED_MARKERS` / `FORBIDDEN_MARKERS` in `scripts/publish-transit.mjs` deliberately |
| Gate C times out, stamp absent | apex `pages.yml` did not run or failed | check apex Actions; the auto-revert has already restored the old build |
| Gate C: stamp ok, sha256 differs | something rewrote the bytes after build | compare `curl -s <url> \| shasum -a 256` to the run's `index-sha256` |
| Gate D red | a non-`/transit` route broke | almost certainly unrelated to this pipeline; check apex `pages.yml` |
| Transit `publish` job red, "APEX_DISPATCH_TOKEN is not set" | the optional instant-trigger secret is absent | either add it (below) or wait ≤15 min for the cron |

## The one optional secret

Everything above works with **no secret**. Only the *instant* push→publish
trigger needs one, because cross-repo dispatch requires a credential:

- **Name:** `APEX_DISPATCH_TOKEN`, set on **this** repo
  (`gh secret set APEX_DISPATCH_TOKEN -R LeBonhommePharma/Transit`).
- **Type:** a fine-grained PAT scoped to `LeBonhommePharma/lebonhommepharma.github.io`
  with **Contents: read-write** *or* just **Metadata: read** plus repository
  `Dispatch` permission. A classic PAT with `repo` also works but is broader.
- **Without it:** pushes still gate correctly and still publish, via the cron,
  within 15 minutes. The `publish` job goes red with an explanatory message so
  the gap is visible rather than silent.

[`LeBonhommePharma/lebonhommepharma.github.io`]: https://github.com/LeBonhommePharma/lebonhommepharma.github.io
