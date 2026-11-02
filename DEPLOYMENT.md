# Deployment

Target: **<https://jd4rider.github.io/wrecking-yard-web/play/>**, listed in the Little
Joy Arcade catalogue as `wrecking-yard`.

## How publishing works

1. Push to `main`.
2. `.github/workflows/pages.yml` checks out the repo, runs
   `node scripts/prepare-site.mjs`, sanity-checks the payload, and uploads `site/`
   as the Pages artifact.
3. `actions/deploy-pages` publishes it.

Pages must have **Build and deployment → Source: GitHub Actions**. That is set
once per repository:

```bash
gh api -X POST repos/jd4rider/wrecking-yard-web/pages -f build_type=workflow
```

(Run it again with `-X PUT` if the repository already has Pages configured.)

## URLs

| What | URL |
| --- | --- |
| Game | `https://jd4rider.github.io/wrecking-yard-web/play/` |
| Cover | `https://jd4rider.github.io/wrecking-yard-web/` |
| Repo | `https://github.com/jd4rider/wrecking-yard-web` |

The arcade probes `preferredPlayUrl` and falls back to `playUrl` when the host is
unreachable. No `preferredPlayUrl` is set for this game because
`wreckingyard.littlejoyarcade.site` has no DNS record or certificate yet. Adding
the subdomain is a separate, explicit step — see `littlejoyarcade/DNS_CONFIGURATION.md`
— and it is deliberately not part of this deploy.

## Catalogue listing

The portal hydrates the catalogue from the Supabase `games` table, so changing
`littlejoyarcade/src/data/games.ts` alone does not change what visitors read. Both
have to be updated:

```bash
# 1. rows: bundled fallback + the live site
cd ~/Programming/littlejoyarcade && git add -A && git commit -m "..." && git push

# 2. database: the copy the live site actually renders
cd ~/Programming/wrecking-yard
SUPABASE_DB_PASSWORD=... node ~/Programming/littlejoyarcade/scripts/publish-game.mjs arcade-manifest.json
```

The password lives in `littlejoyarcade/.env.local` and `~/Programming/.github`
credentials; it is never committed.

## Verifying a deploy

```bash
gh run list -R jd4rider/wrecking-yard-web --limit 3
curl -sI https://jd4rider.github.io/wrecking-yard-web/play/          # 200 text/html
curl -sI https://jd4rider.github.io/wrecking-yard-web/play/Build/WebGL.wasm  # 200 application/wasm, no Content-Encoding
```

A green workflow only proves the files were uploaded. Open the URL and confirm
the Unity progress bar reaches the game itself — a missing or mis-encoded payload
shows up as a stalled bar and an error banner, not a failed deploy.

## Rolling back

Pages deploys are atomic per commit, so the quickest rollback is a revert:

```bash
git revert <bad-commit> && git push
```

To restore an older export instead, check `git log -- build/WebGL` and copy that
tree back over `build/WebGL/`.

## Missing credentials

- `SUPABASE_DB_PASSWORD` — needed to publish the catalogue row (not needed to
  deploy the game).
- DNS access for `wreckingyard.littlejoyarcade.site` — not requested; the game
  works from the `github.io` URL without it.
