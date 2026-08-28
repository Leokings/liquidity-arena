# Bradbury V8 backup scheduler

This Cron-only Cloudflare Worker is an independent trigger for the existing GitHub Actions keeper
and operations watchdog. It does not contain a GenLayer key, keeper password, Neon credential,
journal secret, or contract write implementation.

The V8-only native GitHub schedules remain primary:

- `7,22,37,52 * * * *` — Bradbury V8 epoch and payout keeper
- `47 * * * *` — operations watchdog

Cloudflare checks each keeper slot five minutes later, and the watchdog ten minutes later:

- `12,27,42,57 * * * *` — dispatch the keeper when the current UTC quarter hour has no successful
  `main` run and there is no recent active run, including one from an earlier slot
- `57 * * * *` — dispatch the watchdog only when the current UTC hour has no active or successful
  `main` run

The keeper may exit successfully while an exact outer transaction awaits finality. That success
must not suppress the rest of the hour: a later slot still needs to reconcile the transaction and
create future rounds. The preflight reads up to ten runs from one hour before the current slot,
so a long-running keeper or queued run continues to suppress duplicate dispatch across slot and
hour boundaries. GitHub's 55-minute keeper timeout bounds that active-run lookback. Watchdog
success still covers the full UTC hour. The previous hourly keeper cron remains accepted by the
Worker during Cloudflare trigger propagation, but is no longer part of the deployed configuration.

The preflight accepts native `schedule` and Cloudflare `workflow_dispatch` keeper runs. The
watchdog preflight additionally accepts its automatic `workflow_run` invocation. A preflight
network failure, HTTP 429, or GitHub 5xx errs toward dispatch; HTTP 401/403/404 authorization or
configuration failures stop without dispatching. GitHub's durable workflow concurrency, the Neon
fenced signer lease, the append-only transaction journal, and contract state guards remain the
duplicate-write safety boundary.

## Required access

1. A Cloudflare account authorized interactively through Wrangler. Do not create or paste a
   Cloudflare API token for a local deployment.
2. A new fine-grained GitHub personal access token:
   - resource owner: `Leokings`
   - repository access: only `liquidity-arena`
   - repository permission: **Actions — Read and write**
   - all other repository permissions: no access, except implicit Metadata read
   - use a short expiry and rotate it before expiry

Never paste the GitHub token into chat, a command argument, a file, Wrangler `vars`, or repository
settings. Enter it only into Wrangler's interactive secret prompt.

## Test and deploy

Run these commands from this directory:

```powershell
npm ci
npm test
npm run check
npx wrangler login --use-keyring
npx wrangler whoami
npx wrangler secret put CLOUDFLARE_GITHUB_TOKEN --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

`wrangler login --use-keyring` opens Cloudflare OAuth in the browser and stores the resulting local
credential in Windows Credential Manager. Run the secret command only from the reviewed commit that
is merged to `main`: `wrangler secret put` uses a hidden prompt and immediately creates/deploys a
Worker version, so it is the production activation step rather than local configuration. Paste the
new fine-grained GitHub token there, then run the explicit deploy command to confirm the reviewed
source/config and Cron Triggers are current.

After deployment, verify both Cron Triggers in the Cloudflare dashboard and inspect Worker logs at
the next `:12`, `:27`, `:42`, or `:57` keeper boundary and the `:57` watchdog boundary. A successful dispatch is only queue evidence. Final proof
must include the resulting GitHub job conclusion, keeper journal state, contract post-state,
history health, and watchdog issue state.

## Rotation and removal

To rotate the GitHub token, create a replacement with the same one-repository permission, update
the Worker secret through the hidden prompt, verify one trigger, and then revoke the old token.

To disable the backup without touching the keeper, remove or pause both Cloudflare Cron Triggers.
To remove its credential, run:

```powershell
npx wrangler secret delete CLOUDFLARE_GITHUB_TOKEN --config wrangler.jsonc
```

Deleting or disabling this Worker does not change the native GitHub schedules or any on-chain role.
