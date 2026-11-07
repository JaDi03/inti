# Inti vault contract

A NEAR contract that runs on the user's own account. It holds no funds of its own: the user's
tokens stay in the user's account. Inti gets a function-call key that can only call
`fund_agent`, which sends the amount of one order to the user's agent on NEAR Intents
(`ft_transfer_call` to the verifier with the agent account as `msg`), within limits.

| Method | Who | Notes |
|---|---|---|
| `new(intents, agent)` | the account itself | init; nobody else can initialize |
| `fund_agent(token, amount)` | the account itself (Inti's function-call key) | checks per-order and per-day limits, counted on-chain |
| `set_limit(token, per_order, per_day)` | full-access key | requires 1 yoctoNEAR, so a function-call key cannot call it |
| `remove_limit(token)`, `set_agent(agent)` | full-access key | requires 1 yoctoNEAR |
| `ft_on_transfer` | any token | accepts every incoming transfer |
| `get_config`, `get_limit`, `get_spent_today` | view | |

The user withdraws with a plain token transfer and revokes Inti by deleting its key.

## Build and test

Requires Rust 1.95+ and the `wasm32-unknown-unknown` target.

```bash
cargo test
RUSTFLAGS="-C link-arg=-s --cfg near" cargo build --target wasm32-unknown-unknown --release
```

`cargo near build` produces the same wasm plus a `wasm-opt` pass.
On Windows, `cargo test` needs `AWS_LC_SYS_PREBUILT_NASM=1` (a test dependency builds aws-lc).
