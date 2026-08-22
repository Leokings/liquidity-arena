# Liquidity Arena V8

Liquidity Arena is a GenLayer testnet market game for hourly BTC, ETH, BNB, SOL, and XRP return battles. V8 is the only active product protocol.

## Live release target

| Item | Value |
| --- | --- |
| Network | GenLayer Bradbury testnet |
| EVM chain | `4221` (`0x107d`) |
| Protocol | `LIQUIDITY_ARENA_V8` |
| Settlement policy | `CRYPTO_SPOT_1M_MEDIAN_V1` |
| V8 intelligent contract | `0x06b643f94003e51c6dc47e89524e7fd045630549` |
| V8 deployment transaction | `0xe024e26a5d439858a6505b7f704d778c56ae9b1ccbf95e08f629fff9c762de64` |
| Payout factory | `0xc812709d267372ad7e06807bf0a4d451ed263a30` |
| Factory bind transaction | `0x72a0ce9d8dc5961292381d536910d9d39f703c26c5f8619e48972500df502717` |
| V8 release source SHA-256 | `1e7545f8f0fd121d64f3565675ac8f541d0ba8274abbde60db0dd02d7d777db5` |
| V8 schema SHA-256 | `c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4` |

The V8 deployment and one-time EVM factory binding are finalized. Reserve funding, payout activation, risk enablement, and public routing remain fail-closed until their rollout gates complete.

Bradbury GEN is faucet-issued test currency with no promised monetary value.

## What V8 changes

V8 separates GenLayer settlement from deterministic EVM delivery:

1. Users enter HIGH or LOW positions on the V8 intelligent contract.
2. GenLayer validators resolve the five-venue median result.
3. A claim creates a deterministic payout record and reserves delivery capacity.
4. The bound factory creates an immutable recipient vault on chain 4221.
5. The payout progresses through `PREPARING`, `DISPATCHED`, and `FUNDED_IN_ESCROW`.
6. Only the recipient may call the EVM vault's `withdraw()`.
7. V8 records the terminal `EOA_WITHDRAWN` state after `refresh_payout_withdrawal`.

Activation enables payout rails while leaving `new_risk_enabled=false`. Risk opens only through the separate owner-controlled resume gate.

## Release artifact

The readable contract is [`contracts/LiquidityArenaV8.py`](contracts/LiquidityArenaV8.py). Bradbury deploys the deterministic generated artifact [`contracts/LiquidityArenaV8.release.py`](contracts/LiquidityArenaV8.release.py), which fits the chain's measured pubdata envelope.

```powershell
python scripts/build-v8-release.py --check
npx genvm-linter check contracts/LiquidityArenaV8.release.py
pytest tests/direct/test_liquidity_arena_v8.py -q
npm run test:v8:bradbury
```

The release exposes exactly 25 public methods: 9 views and 16 writes. The generator locks storage layout, public signatures, source hashes, schema hash, and the audited factory literal.

## Local development

```powershell
npm ci
npm test
npm run build
npm run test:e2e
```

Copy `.env.example` to a local ignored env file. The browser and server require the same finalized V8 address, canonical `testnet-bradbury` network, chain 4221, exact roles, factory, stake limits, and reserve floor. Configuration fails closed on any legacy V6/V7 selector.

## Operations

- [`ops/bradbury-v8/README.md`](ops/bradbury-v8/README.md) documents durable deploy/fund/activate/reconcile state.
- [`docs/V8-PAYOUT-RECOVERY.md`](docs/V8-PAYOUT-RECOVERY.md) documents the EVM payout and recovery protocol.
- [`docs/round-keeper.md`](docs/round-keeper.md) documents the V8 keeper and payout reconciler.
- [`docs/HISTORY-API.md`](docs/HISTORY-API.md) documents V8-only public history.
- [`deployments/bradbury-v8.json`](deployments/bradbury-v8.json) is the machine-readable release record.

The keeper may retry preparation, dispatch, confirmation, refresh, and an authorized payout retry. It never withdraws a recipient vault. Durable journal state is persisted before signing, and recovery reuses only the exact recorded transaction identity.

## V7 retirement

V6 and V7 are not runtime fallbacks. Their contract sources and deployment evidence remain only as immutable audit history.

- No V7 URL, registry entry, keeper, scheduler, readiness path, public history row, or claim route is active.
- Retired `?deployment=v6` and `?deployment=v7` URLs canonicalize to V8.
- Arbitrary `contract=` routing is rejected.
- Old test-token liabilities are intentionally not migrated or claimable through this release.
- Rollback means pausing V8 new risk; it never means re-enabling V7.

## Current rollout order

1. Finalize V8 deployment and factory binding.
2. Apply migration 004 and freeze the V8-only app/history/keeper surfaces.
3. Fund the delivery reserve.
4. Activate payout rails with risk still paused.
5. Resume new risk under the explicit faucet-testnet authorization and deploy the V8-only surfaces.
6. Create future epochs and confirm readiness, history health, and scheduler health.
7. Exercise the live payout and withdrawal lifecycle when a position becomes claimable; this is not
   claimed as a pre-resume gate for the present testnet cutover.

All addresses and tokens in this repository are for testnet operation only.
