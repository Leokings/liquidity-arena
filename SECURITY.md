# Liquidity Arena V8 security model

## Scope

The active target is `LIQUIDITY_ARENA_V8` at `0x06b643f94003e51c6dc47e89524e7fd045630549` on GenLayer Bradbury testnet. Payout delivery uses the audited factory `0xc812709d267372ad7e06807bf0a4d451ed263a30` on chain 4221.

Bradbury GEN is test currency. This release is not a real-value production wagering system.

## Primary invariants

1. Only the exact finalized V8 deployment is routable.
2. The factory is immutable, non-proxy, and permanently bound to that V8 address.
3. A payout ID has one recipient, amount, kind, and immutable vault.
4. Principal is credited once; duplicate or wrong-value funding is excess.
5. Only the immutable recipient may withdraw principal.
6. Excess can be recovered only to the immutable reserve sink.
7. Committed delivery reserve covers outstanding payout liability.
8. Payout activation leaves new risk paused.
9. A signed operation is never replaced; recovery uses its exact hash/bytes.
10. V6/V7 are not fallbacks and expose no public claim or keeper route.

## Contract and build controls

The readable V8 source is deterministically transformed into a checked-in release artifact. CI verifies generator reproducibility, storage layout, public ABI, source size, schema hash, linter results, direct behavior, factory/runtime locks, and EVM adversarial tests.

The deployment harness independently checks:

- canonical Bradbury chain and RPC identity;
- source and outer-calldata ceilings;
- exact raw gas estimation with no SDK fallback;
- nonce quiescence, balance, per-transaction and total cost caps;
- signed envelope type, fees, calldata, value, nonce, chain, and empty access list;
- finalized GenLayer execution and canonical outer EVM receipt;
- byte-exact deployed source, schema, constructor, config, and reserve accounting.

## Signing and recovery

Operational state lives under a protected per-user directory and rejects symlink, junction, hard-link, or lexical path escapes. The exact signed transaction is persisted before broadcast. Evidence paths are exclusive and journals are append-only hash chains.

Recovery rules:

- inspect the recorded hash before any network write;
- never sign a replacement for an unresolved operation;
- replay only the exact stored serialized transaction and only with explicit authorization;
- verify canonical receipt and finality before completing state;
- fail closed on nonce, fee, source, config, endpoint, or evidence drift.

Raw private keys are not accepted in environment variables. Encrypted keystores and OS-keychain entries are address-checked, kept out of evidence, and cleared from active references after signing.

## Browser wallet controls

Before every GenLayer or EVM write, the browser rechecks:

- wallet account;
- chain 4221;
- exact V8/factory/vault identity;
- quote or payout identity and amount;
- required finalized precursor state.

The payout journal must persist a prepared action before signing. Storage failure blocks signing. Pending EVM withdrawal hashes block duplicates; reverted or dropped transactions require exact inspection before retry. Recipient withdrawals verify audited factory binding, immutable vault record, transaction calldata/value, receipt status, canonical block, and finalized head.

## Keeper controls

The keeper is restricted to Bradbury, V8, the configured signer, and the exact 25-method schema. A durable lease and journal serialize writes across crashes and scheduled runs. Workflow jobs hard-gate the protected `main` ref before secret-bearing steps.

The keeper can reconcile payout preparation, dispatch, retry, confirmation, and refresh. It cannot withdraw recipient funds.

## Server, history, and database

Readiness requires exact V8 address, roles, factory, source/schema/protocol, stake policy, payout activation, risk activation, reserve capacity, future epochs, and live data feeds.

Public history is V8-only. Schema health requires migrations 001–004 with exact checksums and rejects unknown later migrations. Legacy rows are retained internally only as inactive audit data. Public queries and writes bind the configured V8 address and roles, and payout stage proofs retain distinct retry attempts by transaction identity.

## Web and secret handling

The app uses same-origin RPC adapters with Bradbury defaults, bounded bodies/timeouts, restrictive CORS and CSP, output encoding, rate limits, and secret redaction. User-facing code never receives keeper, database, ingest, or deployment secrets.

Ignored local env files may contain operator secrets and must not be logged or committed. Checked-in `.env.example` contains only public identities and placeholders.

## Incident response

1. Pause V8 new risk.
2. Preserve state, evidence, journals, transaction hashes, and canonical receipt data.
3. Reconcile every signed operation; never replace one speculatively.
4. Keep claims and payout delivery available when safe.
5. Repair V8 and redeploy only through reviewed source/hash gates.

Do not re-enable V7. Old test-token balances and claims are intentionally outside the active release.

## Known limitations

- Bradbury is temporary test infrastructure with no finality or availability SLA.
- Cross-domain completion is multi-transaction and can be delayed by either layer.
- Browser storage, RPC providers, GitHub Actions, Vercel, Neon, and Cloudflare are operational dependencies, not consensus guarantees.
- A complete live payout canary requires an actual resolved/claimable V8 position.
