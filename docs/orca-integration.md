# Orca Whirlpools integration reference

Facts FORGE relies on, read from `orca-so/whirlpools` main @ `cc683ec` (2026-10-12),
crates.io/npm metadata and mainnet RPC on 2026-11-27. Re-verify against the pinned versions
before changing any CPI.

## Pinned versions

| Component | Version | Notes |
|---|---|---|
| Whirlpool program | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | mutable deployment; mainnet config `2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ` |
| Rust client | `orca_whirlpools_client = 8.0.0`, `default-features = false` | solana v3 crates, same types as anchor-lang 1.2.2 |
| TS SDK | `@orca-so/whirlpools 8.0.1`, `-client 7.0.0`, `-core 3.1.0` | requires `@solana/kit ^5`; the whole TS workspace is pinned to kit 5.5.1 |

The generated Rust CPI builders swap `is_signer` / `is_writable` for remaining accounts
(`add_remaining_account(acc, is_writable, is_signer)` vs `.1` read as signer). FORGE builds
Orca instructions by hand (discriminator + borsh args + `AccountMeta`s) and calls
`invoke_signed` directly, so it is not affected.

## Account layouts (offsets include the 8-byte discriminator)

**Whirlpool** (653 bytes, disc `[63,149,209,12,225,128,99,9]`): config 8, bump 40,
tick_spacing u16 41, fee_tier_index u16 43, fee_rate u16 45 (hundredths of a bp),
protocol_fee_rate u16 47, liquidity u128 49, sqrt_price u128 65, tick_current_index i32 81,
protocol_fee_owed_a u64 85, _b u64 93, token_mint_a 101, token_vault_a 133,
fee_growth_global_a u128 165, token_mint_b 181, token_vault_b 213, fee_growth_global_b u128 245,
reward_last_updated_timestamp u64 261, reward_infos 269 (3 × 128: mint +0, vault +32,
extension +64, emissions_per_second_x64 u128 +96, growth_global_x64 u128 +112).
A reward slot is active when its mint is not the default pubkey.

**Position** (216 bytes, disc `[170,188,143,228,122,64,247,208]`): whirlpool 8, position_mint 40,
liquidity u128 72, tick_lower i32 88, tick_upper i32 92, fee_growth_checkpoint_a u128 96,
fee_owed_a u64 112, fee_growth_checkpoint_b u128 120, fee_owed_b u64 136,
reward_infos 144 (3 × {growth_inside_checkpoint u128, amount_owed u64}).

**Tick** (113 bytes, packed): initialized bool 0, liquidity_net i128 1, liquidity_gross u128 17,
fee_growth_outside_a u128 33, fee_growth_outside_b u128 49, reward_growths_outside [u128;3] 65.

**Fixed TickArray** (9988 bytes, disc `[69,97,189,190,110,7,66,187]`): start_tick_index i32 8,
ticks 12 (88 × 113), whirlpool 9956.

**Dynamic TickArray** (148..10004 bytes, disc `[17,216,246,142,225,199,218,56]`):
start_tick_index i32 8, whirlpool 12, tick_bitmap u128 44, ticks from 60. Each tick is a
borsh enum: `0x00` (1 byte) or `0x01` + 112 bytes (Tick without the `initialized` byte).
Offset of tick k = `popcount(bitmap & ((1<<k)-1)) * 113 + (k - that) * 1`.

Tick-array addressing: `TICK_ARRAY_SIZE = 88`,
`start = floor(tick / (ts·88)) · ts·88`, `offset = floor((tick − start) / ts)`.

## PDAs

- whirlpool: `["whirlpool", config, mint_a, mint_b, fee_tier_index u16 LE]`
- position: `["position", position_mint]`
- tick_array: `["tick_array", whirlpool, start_tick_index as decimal ASCII]`
- oracle: `["oracle", whirlpool]`

## Instructions used by FORGE (V1, classic SPL Token only)

| Instruction | Discriminator | Args | Accounts |
|---|---|---|---|
| open_position | `[135,128,47,77,15,152,240,49]` | bump u8, tick_lower i32, tick_upper i32 | funder (W,S), owner, position (W), position_mint (W,S), position_token_account (W, owner ATA), whirlpool, token_program, system, rent, associated_token_program |
| increase_liquidity | `[46,156,243,118,13,205,251,178]` | liquidity u128, token_max_a u64, token_max_b u64 | whirlpool (W), token_program, position_authority (S), position (W), position_token_account, owner_a (W), owner_b (W), vault_a (W), vault_b (W), tick_array_lower (W), tick_array_upper (W) |
| decrease_liquidity | `[160,38,208,111,104,91,44,1]` | liquidity u128, token_min_a u64, token_min_b u64 | same as increase |
| update_fees_and_rewards | `[154,230,250,13,236,209,75,223]` | none | whirlpool (W), position (W), tick_array_lower, tick_array_upper |
| collect_fees | `[164,152,207,99,30,186,19,182]` | none | whirlpool, position_authority (S), position (W), position_token_account, owner_a (W), vault_a (W), owner_b (W), vault_b (W), token_program |
| collect_reward | `[70,5,132,87,86,235,177,34]` | reward_index u8 | whirlpool, position_authority (S), position (W), position_token_account, reward_owner (W), reward_vault (W), token_program |
| close_position | `[123,134,81,0,49,68,98,98]` | none | position_authority (S), receiver (W), position (W), position_mint (W), position_token_account (W), token_program |
| swap | `[248,198,158,145,225,117,135,200]` | amount u64, other_amount_threshold u64, sqrt_price_limit u128, amount_specified_is_input bool, a_to_b bool | token_program, token_authority (S), whirlpool (W), owner_a (W), vault_a (W), owner_b (W), vault_b (W), tick_array_0..2 (W), oracle (W for adaptive-fee pools) |

Notes:
- Exact-output swaps are supported: `amount_specified_is_input = false` makes
  `other_amount_threshold` the maximum input.
- `collect_fees` and `collect_reward` do not accrue; call `update_fees_and_rewards` (or a
  liquidity change) first. `update_fees_and_rewards` fails on zero-liquidity positions.
- `close_position` requires zero liquidity, fees and rewards owed.
- Position authority must sign and equal the owner (or the delegate with amount 1) of the
  position NFT token account. A FORGE PDA owns every vault and strategy position and signs
  with `invoke_signed`. On increase it is also the transfer authority for the source token
  accounts, so those must be PDA-owned.
- `open_position` fails if the pool sets the non-transferable-position flag
  (`reward_infos[1].extension` control flag bit 0). Such pools are not eligible.
- Adaptive-fee pools (fee tier index ≥ 1024) need a writable oracle on swap. Restoration pools
  in v1 must be static-fee pools.

## Math (ported exactly in `math/forge_math/orca.py`)

- Token deltas: increase rounds up (user pays), decrease rounds down. The branch is chosen
  by `tick_current_index` against the position ticks, not by `sqrt_price`.
- `delta_a = ceil_or_floor(((L · Δ√) << 64) / (√hi · √lo))`, error if ≥ 2^64.
- `delta_b = (L · Δ√) >> 64` (+1 when rounding up with a non-zero remainder), error if
  `L · Δ√ ≥ 2^128`.
- Fee growth inside: below = global if lower tick uninitialized, else
  `global − outside_lower` if current < lower, else `outside_lower`. Above = 0 if upper
  uninitialized, else `outside_upper` if current < upper, else `global − outside_upper`.
  Inside = `global − below − above`, all wrapping mod 2^128. Rewards use the same pattern.
- Fees owed on a liquidity change: `(L · (inside − checkpoint)) >> 64`.
- Swap fees enter global growth as `((fee − protocol_fee) << 64) / liquidity`, with
  `protocol_fee = fee · protocol_fee_rate / 10_000`.

## SOL/USDC pools (mint_a = wSOL, mint_b = USDC)

| Fee tier | Address | Tick spacing | Fee rate | Role in FORGE |
|---|---|---|---|---|
| 4 | `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` | 4 | 0.04% | target pool (deepest) |
| 64 | `HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ` | 64 | 0.30% | candidate restoration pool |
| 8 | `7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm` | 8 | 0.05% | candidate restoration pool |
| 1 | `83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d` | 1 | 0.01% | not used |

Adaptive-fee pools for the pair exist (fee tier ≥ 1024) and are not used in v1.
