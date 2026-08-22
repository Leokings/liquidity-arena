# Liquidity Arena V8 submission summary

## Release

Liquidity Arena V8 is a Bradbury testnet market game with GenLayer settlement and deterministic EVM payout escrow.

| Field | Value |
| --- | --- |
| Network | `testnet-bradbury` |
| Chain | `4221` |
| Protocol | `LIQUIDITY_ARENA_V8` |
| V8 address | `0x06b643f94003e51c6dc47e89524e7fd045630549` |
| Factory | `0xc812709d267372ad7e06807bf0a4d451ed263a30` |
| Source SHA-256 | `1e7545f8f0fd121d64f3565675ac8f541d0ba8274abbde60db0dd02d7d777db5` |
| Schema SHA-256 | `c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4` |

## Technical highlights

- five-venue validator-consensus price resolution;
- HIGH/LOW parimutuel settlement with explicit fee and rounding ledgers;
- reserve-backed, idempotent payout state machine;
- immutable recipient EVM vaults and recipient-only withdrawal;
- deterministic generated deployment artifact under Bradbury's pubdata ceiling;
- crash-safe GenLayer/EVM signing and exact-hash reconciliation;
- V8-only browser, API, history, keeper, GitHub, and Cloudflare routing;
- database migration retaining old rows only as inactive audit data.

## Verification surface

The repository gates release generation, GenVM lint, direct V8 behavior, exhaustive schema, Solidity compilation, adversarial factory/vault tests, Bradbury harness recovery, market unit tests, server/history/keeper integration, production build, and desktop/mobile E2E.

Live rollout additionally proves finalized deployment, exact source/schema/config readback, one-time factory binding, reserve funding, payout activation with risk paused, V8-only infrastructure cutover, and deliberate risk resume.

## Legacy policy

V6/V7 sources and deployment records are historical evidence only. No legacy deployment is publicly selectable, scheduled, considered ready, projected as active history, or claimable through the product. Old faucet-token liabilities are intentionally not migrated.

## Testnet disclaimer

Bradbury GEN is faucet-issued test currency. Bradbury and all hosted services are development infrastructure without a finality, availability, or value guarantee.

Detailed design and controls are in [`../TECHNICAL.md`](../TECHNICAL.md), [`../SECURITY.md`](../SECURITY.md), and [`V8-PAYOUT-RECOVERY.md`](V8-PAYOUT-RECOVERY.md).
