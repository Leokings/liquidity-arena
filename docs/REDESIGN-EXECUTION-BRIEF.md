# Liquidity Arena StudioNet V7 execution brief

This brief turns [the V7 product specification](REDESIGN-SPEC.md) into a release sequence. It records
what is deployed, what is verified, and what must still pass before the public V7 cutover. A checked
box must be backed by reproducible local output or immutable StudioNet/public evidence.

## 1. Frozen design

| Decision | Value |
| --- | --- |
| Runtime | Single-chain GenLayer StudioNet demo |
| Protocol / policy | `LIQUIDITY_ARENA_V7` / `CRYPTO_SPOT_1M_MEDIAN_V1` |
| Currency | Native faucet test GEN |
| Cadence | 24 exact UTC hourly targets per day |
| Schedule | 20m buffer, 20m wagering, 20m battle |
| Assets | BTC, ETH, BNB, SOL, XRP |
| Venues | Binance, OKX, Bybit, Gate, KuCoin |
| Evidence | Completed 1m boundaries, 3-of-5 complete baskets, median return |
| Pools | HIGH and LOW in one epoch, one shared vector |
| Fee | 2% of losing pool; 5% hard cap |
| Stake limits | 0.1–10 test GEN per wallet/objective |
| Exceptional results | Eligible-principal refund, zero fee |
| Resolve / timeout | Permissionless at `E+120s` / `E+24h` |
| Scheduled privilege | Fixed-terms epoch creation only |
| Public host | Vercel |
| Durable history | Neon schema migrated; initial settled-state ingestion pending |

V6 remains only for old reads, permissionless resolve/timeouts, and claims.
This is an application/automation policy: the deployed V6 owner creation capability still exists and
must remain unused.

## 2. Canonical hourly example

For a 15:00 UTC target:

| Time | Behavior |
| --- | --- |
| 14:00 | Buffer begins; epoch already exists. |
| 14:20 | HIGH and LOW wagering opens. |
| 14:40 | Wagers lock; battle baseline begins. |
| 15:00 | Battle ends at the exact clock boundary. |
| 15:02 | Permissionless resolution becomes available. |
| after actual finality | Eligible claims/refunds become available. |
| next day 15:00 | Permissionless timeout becomes available if still open. |

The 16:00 epoch begins on schedule even if the 15:00 resolver is still finalizing.

## 3. Phase A — V7 contract and deployment

### Delivered

- [x] `contracts/LiquidityArenaV7.py` with one shared HIGH/LOW epoch.
- [x] Fixed five-asset/five-venue 3-of-5 median policy.
- [x] Fixed contract-level stake limits and snapshotted future fee.
- [x] Owner/keeper separation and two-step ownership transfer.
- [x] Keeper/owner-only epoch creation with one-hour notice and 26-hour keeper horizon.
- [x] Permissionless resolution and timeout.
- [x] Pull claims, fee isolation, solvency checks, zero-fee exceptional refunds, and bounded views.
- [x] GenVM lint and deterministic direct suites.
- [x] Deployment finalized at `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`.
- [x] Deployment/config/catalog/source read-back recorded.

### Evidence

- transaction: `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579`;
- consensus: `FINALIZED`, `MAJORITY_AGREE`, successful execution;
- source SHA-256:
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- V7 direct tests: 22/22;
- combined V6/V7 direct tests: 37/37;
- schema: 29 methods.

### Remaining

- [ ] Complete independent contract-focused review and remediate critical/high findings.
- [ ] Prove the 24-hour timeout path live or preserve it as a clearly disclosed limitation.
- [ ] Define protocol-safe child-transfer recovery for any real-value future.

## 4. Phase B — hourly automation and role rotation

### Delivered

- [x] Derive exactly 24 future hourly targets.
- [x] Reconcile bounded open-epoch pages rather than every terminal historical epoch.
- [x] Validate exact chain, contract, policy, roles, stake limits, timing, fee, assets, and venues.
- [x] Recheck active signer immediately before every write.
- [x] Bound/serialize writes and require exact finalized receipts/post-state.
- [x] Create and verify the initial 24-hour V7 schedule.
- [x] Pin GitHub workflow action revisions and use concurrency.
- [x] Schedule minute-3 execution plus minute-13 watchdog.

### Remaining

- [x] Create the dedicated encrypted keeper account.
- [x] Install environment-scoped keystore secrets and exact role variables.
- [x] Use the owner only once to call `set_keeper(dedicated_keeper)`.
- [x] Verify the on-chain keeper and public repository variable match.
- [ ] Capture one activated workflow run proving the imported runtime signer matches.
- [ ] Activate from the default branch and capture one successful scheduled run.
- [ ] Connect coverage, role drift, source quorum, finality, and failure alerts.

The owner key must never enter CI. Dedicated keeper
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` replaced the bootstrap wallet through owner transaction
`0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, which reached `FINALIZED`,
`MAJORITY_AGREE`, with successful leader execution. Exact `get_config` and repository variable
`V7_KEEPER_ADDRESS` match; secret names `V7_KEEPER_KEYSTORE_B64` and
`V7_KEEPER_KEYSTORE_PASSWORD` are present in environment `studionet-keeper`. Local use of that
keeper created `1787256000` via finalized transaction `0xe10ce0bf…a9c4` and `1787259600` via
finalized transaction `0x00398a3c…9058`; both exact post-states were verified OPEN. This proves the
limited role, while default-branch runtime proof remains open.

## 5. Phase C — funded V7 canary

Use at least two faucet-funded wallets and positions on distinct assets/objectives. Record exact
attoGEN values and full hashes.

Required proof:

1. [x] every wager reaches `FINALIZED` and exact `get_entry` post-state;
2. [x] both HIGH and LOW have distinct backing;
3. [x] one permissionless shared resolution reaches `FINALIZED` and matches the authoritative
   returns;
4. [x] fee and refund modes match the actual winner configuration;
5. [x] three eligible payout/refunds finalize through their exact EOA children;
6. [x] an ineligible loser is rejected without state change;
7. [x] player liability, accrued fee, contract balance, and wallet deltas conserve exactly;
8. [x] the read-only delivery monitor is extended/tested for V7 and records exact parent/child proof
   without retrying anything.

Resolution `0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66` selected unbacked SOL HIGH
and backed BNB LOW. Three exact claim children delivered 0.100, 0.100, and 0.198 GEN; loser claim
`0xb0d9889a…e688` failed as expected. Fee parent `0x3df8d942…bb01f` and child `0x566082ce…470e`
delivered 0.002 GEN. A/B/contract balances were 0.700/0.648/0.400 GEN before resolution,
0.800/0.946/0.002 after claims, and 0.802/0.946/0 after fee withdrawal. Liability and accrued fees
ended at zero; 1.748 GEN was conserved throughout. Full hashes are recorded in
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).

## 6. Phase D — V6 drain and compatibility

### Delivered

- [x] V6 is classified as legacy, not an alternate active write target.
- [x] The drain process contains no `create_epoch` operation.
- [x] Due V6 epochs `1787155200` and `1787158800` were resolved on 2026-08-19.
- [x] Later due V6 epochs `1787162400` and `1787166000` were resolved by `0x03f2ac80…0399` and
  `0x7e8030f0…27bb`.
- [x] Historical V6 funded payout/refund evidence remains published.
- [x] The browser deployment registry separates V7 and V6 identities.
- [x] The retained V6 owner-only creation capability is documented as an abstention/monitoring risk,
  not falsely described as revoked on-chain.

### Required compatibility checks

- [ ] V7 is the only new wager target after cutover.
- [ ] Old V6 epochs and wallet positions remain discoverable.
- [ ] Eligible V6 claims and timeouts remain callable.
- [ ] Raw/arbitrary contract URL injection fails closed.
- [ ] Unreadable V6 liability is reported as unknown, never zero.
- [ ] Rollback does not reactivate V6 creation.

V6 may be removed from the browser only after liabilities and user recovery obligations are closed.

## 7. Phase E — durable history

Neon is a durable projection of finalized settled epochs. Its production schema migration is
applied, but initial finalized-epoch ingestion is pending. It is not an oracle and must not become
required for wager, resolve, timeout, or claim correctness.

Required completion:

- [x] review and apply the migration through the approved temporary-branch workflow;
- [x] read back the expected six tables and four indexes;
- [x] scope the ingestion secret to server/GitHub environment use, not browsers;
- [x] implement/test ingestion restricted to allowlisted contract/protocol identities;
- [x] implement/test rejection of non-final or mismatched records;
- [x] implement/test idempotency and unique epoch identity;
- [x] expose/test bounded read APIs with caching/rate limits;
- [x] derive/reconcile projected records from authoritative chain views;
- [x] report ingestion lag/failure without making projection availability settlement authority;
- [ ] document backup/rebuild and rollback behavior.

Live production completion remains:

- [ ] run the initial finalized-epoch sync against the migrated schema;
- [ ] repeat the same sync and prove production idempotency;
- [ ] verify populated read/health behavior and a database-outage recovery rehearsal.

Until these checks pass, documentation and UI must describe durable database history as pending.

Applied migration ID: `aa7617fa-bfa7-4d48-9b30-f60afeda43a1`. Normalized marked-DDL SHA-256:
`dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`. Raw migration-file SHA-256:
`8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`.

## 8. Phase F — browser/API release candidate

Required release behavior:

- exact phase/countdown and 24-hour schedule;
- V7-only new writes plus V6 read/resolve/timeout/claim recovery compatibility;
- finalized/provisional/degraded labels;
- live ROUND reset only at battle baseline;
- rolling 1H/4H/1D/1W context unaffected by epoch reset;
- territory area by return, direction by momentum, turbulence by volatility/disagreement;
- pending transaction persistence, exact explorer links, claim history, and recovery state;
- same-origin StudioNet RPC and no secrets in the bundle;
- bounded API input/output, timeouts, cache, rate limits, strict CORS/CSP, and redacted logs;
- readiness based on the same exact deployment config used by the application.

Cutover procedure:

1. [ ] configure a V7 preview with the recorded address and expected roles;
2. [ ] verify health, readiness, chain `0xf22f`, all five feeds, kline history, CSP, and console;
3. [ ] test V7 wallet entry/claim UX and V6 legacy history/claim UX;
4. [ ] verify mobile, refresh, delayed finality, stale feed, and database outage behavior;
5. [ ] preserve the last verified production artifact and environment for rollback;
6. [ ] promote only after the remaining cutover checks;
7. [ ] rerun the same checks against the production alias.

Vercel production currently remains V6. Do not claim V7 public completion before promotion and
post-promotion verification.

The safe compatibility artifact is deployment `dpl_DQEvnGup417wvTxuxzeNfJvySiM5`, immutable URL
`https://liquidity-arena-2qlh5a5kn-leokings588-5902s-projects.vercel.app`, source commit
`dbc2288a6adc745261128a55b555e8a34574db1e`, and bundle `market-Co0HBgo2.js` with SHA-256
`484b3c8ba3e40cb249a694ecd30bbe97df6685e1c858ea54639e8039eec43cd9`. New wagers are disabled on
both the default and explicit V7 route. `/readyz` is expected `503` because the active V6
compatibility artifact lacks future keeper coverage. Six older deployments were retired/deleted.

## 9. Phase G — submission package

Required artifacts:

- [ ] clean public repository with reproducible setup;
- [x] V7 architecture, contract, keeper, history, and security documentation;
- [x] V7 deployment record and funded canary evidence;
- [x] V6 drain/legacy-liability and retained-owner-capability explanation;
- [ ] current test/build/dependency outputs;
- [ ] independent review and remediation record;
- [ ] screenshots and short end-to-end demonstration video;
- [ ] StudioNet/faucet-GEN limitations and provider/legal disclosures;
- [ ] public Vercel URL and rollback record.

## 10. Operational constraints

- StudioNet observed finality is not an SLA; always wait for actual `FINALIZED` status.
- GitHub cron is best-effort; contract time defines every epoch and permissionless methods avoid an
  exclusive settlement operator.
- Public exchange endpoint availability and terms can change.
- Vercel request runtimes must not own unbounded finality waits.
- Claims require exact child monitoring; no automatic replay is permitted.
- Neon can improve discoverability but cannot authorize a payment.

## 11. Current truthful status

The V7 contract, initial full-day schedule, funded canary, dedicated keeper rotation, and Neon schema
migration are complete. The release is not finished because default-branch scheduler proof, initial
durable-history ingestion, public V7 promotion, timeout evidence, monitoring, and independent reviews
remain.

The next safe sequence is:

1. activate and verify the default-branch keeper runtime signer and coverage;
2. run initial and repeated Neon ingestion proof;
3. deploy and verify the V7 preview;
4. promote with V6 legacy compatibility and a tested rollback;
5. finish operational/external review and submission media.
