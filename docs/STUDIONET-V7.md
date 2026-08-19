# StudioNet V7 deployment and cutover record

## Deployment

| Field | Value |
| --- | --- |
| Network | GenLayer StudioNet |
| Chain ID | `61999` (`0xf22f`) |
| Protocol | `LIQUIDITY_ARENA_V7` |
| Policy | `CRYPTO_SPOT_1M_MEDIAN_V1` |
| Contract | [`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`](https://explorer-studio.genlayer.com/address/0xb2ae59aE641f571726Ae81E30080f8c2192b15EF) |
| Deployment tx | [`0x85ca7d…c579`](https://explorer-studio.genlayer.com/tx/0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579) |
| Created | `2026-08-19T17:15:58.617644Z` |
| Finalized | `2026-08-19T17:16:34.249123Z` |
| Consensus | `FINALIZED`, `MAJORITY_AGREE` |
| Execution | `FINISHED_WITH_RETURN` |
| Source SHA-256 | `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F` |

The machine-readable source of record is
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json). This document adds operational
context; it does not replace the JSON evidence.

## Deployed policy

- assets: BTC, ETH, BNB, SOL, XRP;
- venues: Binance, OKX, Bybit, Gate, KuCoin;
- quorum: at least three complete five-asset venue baskets;
- interval: completed one-minute spot candles;
- aggregation: deterministic median return per asset;
- objectives: HIGH and LOW from one shared vector;
- cadence: 24 exact UTC hourly targets per day;
- phases: 20-minute buffer, 20-minute wagering, 20-minute battle;
- resolution: permissionless from `E+120s`;
- timeout: permissionless from `E+24h`;
- currency: native faucet test GEN;
- stakes: 0.1–10 GEN per wallet/objective;
- fee: 2% of losing pool by default, hard-capped at 5%.

## Role state

The live role state currently identifies:

- owner/treasury: `0x797d3b25fb2cca0ff93f60df1910267f3822d655`;
- dedicated keeper: `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`;
- pending owner: zero address.

These are public contract roles, not secret material. The constructor initially recorded bootstrap
keeper `0x87e94edab4418e8a9ea37c0fab0675cf0602a9f2`. Owner transaction
`0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc` replaced it with the dedicated
keeper and reached `FINALIZED`, `MAJORITY_AGREE`, with successful leader execution. Exact
`get_config` read-back confirms the dedicated address. GitHub environment `studionet-keeper` now has
secret names `V7_KEEPER_KEYSTORE_B64` and `V7_KEEPER_KEYSTORE_PASSWORD`, and repository variable
`V7_KEEPER_ADDRESS` holds the same public address. The owner key must never enter workflow or Vercel
secrets. Reconcile job `96218469576` in run `32299468899` passed the exact default-branch
profile/runtime-signer preflight.

## Schedule state

Twenty-five exact-hour epochs were created and verified. Canary epoch `1787166000` was created by
`0x48658624ab4923cc81b594863cca424f0f7a7026dc29f2fe71241297f50672cb`. The full-day set contains
24 IDs from `1787169600` through `1787252400`; its first and final creation transactions are
`0x7b94b2d0dc4d0970482e60a2cec1fc4d3c3bcf0592816e992b3acbc9474b7726` and
`0x443afcf771f1c5751bdc0e525b75b8d04e7378ef37bb7f817799f98f36c7677f`. This proves full-day
derivation and creation, but it does not prove continuous scheduled operation. The default-branch
workflow is activated; long-run monitoring remains. The dedicated keeper rotation is complete.

The dedicated keeper then created two additional exact-hour epochs locally. Epoch `1787256000` used
transaction `0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4`; epoch `1787259600` used
`0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`. Both transactions finalized
and both exact epoch post-states were verified OPEN. These actions prove the dedicated account's
limited keeper role, but are not default-branch scheduled-run evidence.

The keeper privilege is limited to fixed-terms epoch creation. It cannot choose fees or stake limits.
Resolution and timeout are public contract methods, so any account may submit them after the
immutable gates.

## Verification state

Completed:

- finalized deployment with majority agreement and successful execution;
- recorded source hash and live config/catalog/role read-back;
- GenVM lint with 29 schema methods;
- V7 direct tests 22/22;
- combined V6/V7 direct tests 37/37;
- 27 created epochs evidenced: one canary, an initial 24-target full-day schedule, and two finalized
  dedicated-keeper creates with verified OPEN post-state;
- fail-closed V7 keeper profile checks and pre-write signer recheck;
- V6 drain tooling and a read-only claim-delivery monitor with explicit V6/V7 profiles;
- dual V7/V6 browser-deployment registry implementation;
- completed funded V7 canary settlement, claim delivery, rejection, conservation, and fee withdrawal;
- finalized dedicated-keeper rotation, exact `get_config` role read-back, and matching GitHub
  environment secret names/repository address variable;
- scheduled V7 reconciliation run `32298454771`, later successful no-action reconcile/history run
  `32299468899`, final observed reconcile/history run `32300282482`, and successful scheduled V6
  drain run `32297047031`;
- Neon production migration application, six-table/four-index schema read-back, and initial bounded
  V7/V6 E19 snapshot synchronization/read-back.

Pending:

- long-run dedicated-keeper/drain monitoring and alert evidence;
- live 24-hour timeout-refund proof;
- transaction-proof backfill and outage-recovery verification;
- continued public browser/wallet soak and rollback rehearsal without re-enabling V6 writes;
- independent security and provider/legal review.

The deploy finalized in about 36 seconds. Earlier successful StudioNet operations were also observed
in the tens-of-seconds range, but no observation is a finality bound or SLA. The application waits for
actual `FINALIZED` status and the exact EOA child when value is delivered.

## Funded canary evidence

A V7 canary epoch was created for `1787166000`. Four 0.1 GEN wagers finalized and each post-state
was verified:

- account `0x797d…d655`: HIGH BTC
  `0x58f6907284ad6616ec9a4b030954ddcf257fd4bf99089be20245c46c53dbc4fa` and LOW XRP
  `0xa6284710314653508ab987b585892d134e3efbf96d78cd235b07e56dc8ce5831`;
- account `0x87e9…a9f2`: HIGH ETH
  `0xc0d5401c97f87ef63a11adbb4a6db41d3f02ee2e927082847216eab48d142a19` and LOW BNB
  `0x80c1d3064ff30a1b070fbadd56598191873d881df02843d88a6dc000c3917e9c`.

The pre-resolution balances were 0.700 GEN for account A, 0.648 GEN for account B, and 0.400 GEN in
the contract. Resolution
`0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66` finalized successfully with
four qualified venues—Binance, OKX, Gate, and KuCoin—and digest
`24737b82b161c1bb05e6ceccf47c848b4a13078eccad7f810a54baa0f7fc31cf`. HIGH selected SOL at
`4394531` ppb with `REFUND_UNBACKED_WINNER`; LOW selected BNB at `170154` ppb with `PARIMUTUEL`.

Three participant payments were proven through exact finalized parent/EOA-child pairs:

- account A HIGH refund, 0.100 GEN: parent
  `0x83a7a0069c2996d74e2277c652df05583225ef2a6af8e7f6c3672abb3682b2f5`, child
  `0x334b4a1b288a8c88dd0e7de3df6eddee28fbaaffbd3733994aef5c028a5f434e`;
- account B HIGH refund, 0.100 GEN: parent
  `0x53adf85d1ad4b531807bc309744d72fe834d3500908c27c33e19c69aa68708e5`, child
  `0x0899c738a7726c98051252c3fab96fd96debf4b279d69e1e5a8b3a8c9adffe3c`;
- account B LOW payout, 0.198 GEN: parent
  `0xf8a3197cfb168a9019b9a9ac0499a253a92c7e1e58762982b92caf27ca3c6031`, child
  `0x7cfe12e50ab3f8636bd89d361d361012691fd0cc745c3468b1e01b6e6576c886`.

Account A's ineligible LOW XRP claim
`0xb0d9889a29247ed2754975eea299dfdd5427bd66a2e1311f1e303fd7b5cbe688` finalized with the expected
failed execution and no state change. After the successful claims, account A held 0.800 GEN,
account B held 0.946 GEN, the contract held 0.002 GEN, player liability was zero, and accrued fees
were 0.002 GEN.

Fee-withdrawal parent
`0x3df8d942bd9c5d699ee0d7816761ec5fd6264108d3a3e8bf3486c2c4f4fbb01f` and child
`0x566082ceef10482356f7aeac310098b7ece8f9c0a7e054eb1db718623602470e` delivered the exact 0.002 GEN
fee to account A/treasury. Final balances were 0.802 GEN for account A/treasury, 0.946 GEN for
account B, and zero for the contract; liability and accrued fees were zero, and withdrawn fees were
0.002 GEN. The total 1.748 GEN was conserved before resolution, after claims, and after withdrawal.

Do not substitute the V6 funded proof. V6 evidence validates the predecessor's normal payout and
unbacked-winner refund paths only.

## Legacy V6

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` remains a public legacy recovery surface while V7 is
active. The app disables V6 new wagers and creation while retaining old reads, resolves/timeouts, and
claims. Its due epochs `1787155200` and
`1787158800` were resolved on 2026-08-19 by
`0xae0ce45340fdeaf1c40c41cf12f10bc2dc42319a03aed0c5a706cd5a3ade1480` and
`0x09f01c2afb065a5ae27df1b791215a421fb2592d1eb65c85988c20072cc0e735`. A later permissionless drain
resolved epoch `1787162400` with `0x03f2ac803896b84fdfadbc4329ea4a085851d0559f0c3213c8eca4be659e0399`
and epoch `1787166000` with `0x7e8030f0975d86479a01a398b88d10b2606c466eec78046fc84eca18c55d27bb`.
Supported public app and automation paths expose no new V6 epoch or wager action; historical
resolve, timeout, and claim paths remain. The deployed V6 owner creation capability still exists and
must not be used.

At V7 cutover:

- all new wagers must target V7;
- V6 epochs, positions, claims, and eligible timeouts must remain discoverable;
- no arbitrary address may be introduced through the URL;
- readiness must report legacy liability separately and never turn an unreadable value into zero;
- rollback must restore browser availability without re-enabling V6 creation.

## Durable history

The Neon production migration was applied through the approved temporary-branch workflow with
normalized marked-DDL SHA-256 `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
(raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`); six expected tables and
four expected indexes were read back. Workflow run `32299468899`, history job `96218806119`, then
synchronized two deployments, two epochs, and two snapshots from state read at
`2026-08-19T20:38:39.397Z`. Public history returns full resolved/determined V7 and V6 snapshots for
E19 (`1787166000`). Both `verifiedProofs` arrays are empty: state projection is live, but transaction-
proof backfill is not. Later run `32300282482`, reconcile job `96221017562` and history job
`96221327115`, also succeeded from state read at `2026-08-19T20:47:19.912Z`. Public history now has
resolved/determined V7 E20 and E19 plus V6 E19 without duplicating the overlapping V6 row;
`proofsVerified` remained zero. Outage recovery remains pending. This off-chain cache is keyed to
allowlisted chain/contract/epoch state and cannot choose winners or make claims eligible.

## Public cutover record

The production alias [liquidity-arena.vercel.app](https://liquidity-arena.vercel.app) now targets V7
while retaining V6 legacy recovery. The verified code artifact immediately before this evidence-only
documentation refresh is:

- source commit: `45be825084cce9e97579ca42266e318e2e97fe17`;
- CI run: `32299866117`, with browser/operator job `96219707620` and intelligent-contracts job
  `96219707869` both successful;
- deployment: `dpl_HZ4iAxBgnzotYUBQVXWxS8uDguW3`, status READY;
- immutable URL:
  [liquidity-arena-etugq1wnj-leokings588-5902s-projects.vercel.app](https://liquidity-arena-etugq1wnj-leokings588-5902s-projects.vercel.app);
- browser bundle: `market-DECrh0Dy.js`, SHA-256
  `d82c6975f0275add1e355a3d298a0170aae483f26788d4e9431a2a259cfe85ac`;
- `/healthz`, `/readyz`, and `/api/history-health`: `200`;
- readiness: exact V7 contract/roles/policy, two covered future epochs, five feeds, and readable V6
  with zero known player liability.

The previous V6 artifact `dpl_DQEvnGup417wvTxuxzeNfJvySiM5` remains a READY rollback reference. Any
rollback must preserve V6 new-write disabling. Continue browser/wallet soak, outage tests, external
review, and proof backfill. The later evidence-only documentation commit is intentionally not claimed
as the source of the code artifact above.
