# Inti Spending Limits contract (v1.0.0)

Give AI money without handing it the keys to everything.

A NEAR contract that runs on the user's own account. It is not a vault and has no custodian:
it holds no funds of its own, and the user's tokens stay in the user's account. Inti gets a
function-call key that can only call `fund_agent`, which sends one order to the user's agent on
NEAR Intents (`ft_transfer_call` to the verifier with the agent account as `msg`), within the
limits the user sets.

## The limits

- **Per order:** no single order can send more than `per_order`.
- **Per day:** the orders of the last 24 hours together can never pass `per_day`. It is a
  rolling window, not a calendar day: an order counts for exactly 24 hours after it is sent.
- **At most 24 orders** per token in any 24 hours.
- **At least 80 Tgas** attached to each order, so it never fails halfway for lack of gas. An
  order with less is refused before it counts.

```rust
require!(new_spent <= limit.per_day.0, "over the daily limit");
```

`src/lib.rs`: before sending, the contract adds the new order to what the last 24 hours
already sent. If the total would pass the daily limit, the order is refused and nothing moves.

## Methods

| Method | Who | Notes |
|---|---|---|
| `new(intents, agent)` | the account itself | init; nobody else can initialize |
| `fund_agent(token, amount)` | the account itself (Inti's function-call key) | checks both limits, the order cap and the gas |
| `set_limit(token, per_order, per_day)` | full-access key | requires 1 yoctoNEAR, so a function-call key cannot call it |
| `remove_limit(token)`, `set_agent(agent)` | full-access key | requires 1 yoctoNEAR |
| `ft_on_transfer` | any token | accepts every incoming transfer and changes nothing |
| `get_config`, `get_limit` | view | |
| `get_spent_last_24h(token)` | view | what counts against the daily limit now |
| `get_orders_last_24h(token)` | view | each order still counting, with its time (`at`, nanoseconds) and amount |

Every order and every owner change is logged as a NEP-297 event (`standard:
"inti_spending_limits"`): `order_sent`, `order_resolved`, `limit_set`, `limit_removed`,
`agent_set`.

## If something goes wrong

The user withdraws with a plain token transfer. To stop Inti at once, the user deletes Inti's
key from the account with their full-access key: from then on nothing can call `fund_agent`.
A stolen Inti key can send at most the limits above, and can use up the 24 orders of a day,
which blocks new orders for up to 24 hours. Deleting the key ends both.

## How the contract is checked

| Check | What it shows | Where |
|---|---|---|
| Unit and actor tests | each method against the owner, Inti's key, a stranger and other contracts | `src/lib.rs`, `tests/actors.rs` |
| Property tests | random sequences of orders, callbacks and time never let more than the limits through in any 24 hours | `tests/invariants.rs` |
| Sandbox tests | real access keys, gas, failed promises and callbacks on a local NEAR node | `tests/sandbox/` |
| Formal proofs (Kani) | six rules proven for every possible value | `verification/` |

## Build and test

Requires Rust 1.99.1 (the version CI uses) with the `wasm32-unknown-unknown` target, and
[cargo-near](https://github.com/near/cargo-near) to build the wasm.

```bash
# unit, actor and property tests (about 8 minutes; the property tests take most of it)
cargo test
# on Windows, a test dependency builds aws-lc and needs:
AWS_LC_SYS_PREBUILT_NASM=1 cargo test

# contract wasm: target/near/inti_spending_limits.wasm
cargo near build non-reproducible-wasm

# sandbox tests: build the test token, then point the tests at both wasm files.
# Each test starts its own local node, so run two at a time.
(cd tests/mocks/mock-ft && cargo near build non-reproducible-wasm)
SPENDING_LIMITS_WASM=$PWD/target/near/inti_spending_limits.wasm \
MOCK_FT_WASM=$PWD/tests/mocks/mock-ft/target/near/spending_limits_mock_ft.wasm \
cargo test --manifest-path tests/sandbox/Cargo.toml -- --test-threads=2

# formal proofs (Kani runs on Linux or macOS)
cd verification && cargo kani
```

On Windows, `cargo test` needs `AWS_LC_SYS_PREBUILT_NASM=1` (a test dependency builds aws-lc).
