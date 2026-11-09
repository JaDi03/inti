//! Property tests over random sequences of orders, callbacks and time, written from what
//! the product promises the user, not from the contract's own variables:
//! - Inti never sends more than the per-order limit in one order.
//! - Within one UTC day the agent never receives more than the daily limit, whatever each
//!   token call did and in whatever order the callbacks arrive.
//! - Every order goes to the NEAR Intents verifier for the user's own agent, and nowhere else.
//! - Nobody but the account itself can change anything.
//!
//! The same sequences also run on the plain model in `verification/src/model.rs` (where the
//! Kani proofs live), and both must agree at every step.

#[path = "../verification/src/model.rs"]
mod model;

use inti_spending_limits::SpendingLimits;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseError};
use proptest::prelude::*;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn call_from(predecessor: &str, deposit_yocto: u128, timestamp: u64) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(id("user.near"))
        .predecessor_account_id(id(predecessor))
        .signer_account_id(id(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .block_timestamp(timestamp);
    testing_env!(builder.build());
}

fn quiet_panics() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| std::panic::set_hook(Box::new(|_| {})));
}

fn ok<F: FnOnce() -> R, R>(f: F) -> Option<R> {
    catch_unwind(AssertUnwindSafe(f)).ok()
}

#[derive(Clone, Debug)]
enum TokenOutcome {
    /// The token moved this share (in percent) of the order and reports it honestly.
    Moved(u8),
    /// The token call failed before moving anything (for example: not enough balance).
    FailedNothingMoved,
    /// The transfer happened but the token's resolve step failed afterwards.
    FailedAfterMoving,
    /// The token reports more than the order.
    OverReported(u128),
}

#[derive(Clone, Debug)]
enum Step {
    Order { amount: u128 },
    Callback { pick: usize, outcome: TokenOutcome },
    Wait { nanos: u64 },
}

fn outcome() -> impl Strategy<Value = TokenOutcome> {
    prop_oneof![
        (0u8..=100).prop_map(TokenOutcome::Moved),
        Just(TokenOutcome::FailedNothingMoved),
        Just(TokenOutcome::FailedAfterMoving),
        (1u128..1_000).prop_map(TokenOutcome::OverReported),
    ]
}

fn steps(per_order: u128) -> impl Strategy<Value = Vec<Step>> {
    let order = prop_oneof![
        (1..=per_order).prop_map(|amount| Step::Order { amount }),
        (0..=per_order.saturating_mul(3)).prop_map(|amount| Step::Order { amount }),
    ];
    let wait = prop_oneof![
        (0u64..10_000_000_000).prop_map(|nanos| Step::Wait { nanos }),
        (0u64..=2 * model::NANOS_PER_DAY).prop_map(|nanos| Step::Wait { nanos }),
    ];
    let callback =
        (0usize..64, outcome()).prop_map(|(pick, outcome)| Step::Callback { pick, outcome });
    prop::collection::vec(prop_oneof![4 => order, 3 => callback, 1 => wait], 1..60)
}

fn limits() -> impl Strategy<Value = (u128, u128)> {
    (1u128..1_000).prop_flat_map(|per_order| (Just(per_order), per_order..per_order * 6))
}

/// Limits and a sequence of steps whose order sizes are drawn around that per-order limit.
fn scenario() -> impl Strategy<Value = (u128, u128, Vec<Step>)> {
    limits()
        .prop_flat_map(|(per_order, per_day)| (Just(per_order), Just(per_day), steps(per_order)))
}

struct Pending {
    amount: u128,
    day: u64,
}

fn check_order_receipts(amount: u128) {
    let receipts = get_created_receipts();
    let mut calls = Vec::new();
    for receipt in &receipts {
        for action in &receipt.actions {
            match action {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } => {
                    let args: Value = serde_json::from_slice(args).unwrap();
                    calls.push((
                        receipt.receiver_id.to_string(),
                        String::from_utf8(method_name.clone()).unwrap(),
                        args,
                        *attached_deposit,
                    ));
                }
                other => panic!("an order created an action other than a function call: {other:?}"),
            }
        }
    }
    assert_eq!(calls.len(), 2);
    let (receiver, method, args, deposit) = &calls[0];
    assert_eq!(receiver, "usdc.near");
    assert_eq!(method, "ft_transfer_call");
    assert_eq!(args["receiver_id"], Value::from("intents.near"));
    assert_eq!(args["msg"], Value::from("agent.near"));
    assert_eq!(args["amount"], Value::from(amount.to_string()));
    assert_eq!(*deposit, NearToken::from_yoctonear(1));
    assert_eq!(calls[1].0, "user.near");
    assert_eq!(calls[1].1, "on_fund_resolved");
}

proptest! {
    // 512 cases by default; PROPTEST_CASES overrides it (mutation runs use fewer).
    #![proptest_config(ProptestConfig {
        cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(512),
        ..ProptestConfig::default()
    })]

    #[test]
    fn the_agent_never_receives_more_than_the_limits((per_order, per_day, seq) in scenario(), start_day in 1u64..30_000) {
        quiet_panics();
        let mut now = start_day * model::NANOS_PER_DAY + 1;
        call_from("user.near", 0, now);
        let mut contract = SpendingLimits::new(id("intents.near"), id("agent.near"));
        call_from("user.near", 1, now);
        contract.set_limit(id("usdc.near"), U128(per_order), U128(per_day));

        let limit = model::check_limit(per_order, per_day);
        prop_assert!(limit.is_some());
        let mut usage: Option<model::Usage> = None;
        let mut pending: Vec<Pending> = Vec::new();
        // What the agent actually received, per day the order was counted on.
        let mut received: BTreeMap<u64, u128> = BTreeMap::new();

        for step in seq {
            match step {
                Step::Order { amount } => {
                    call_from("user.near", 0, now);
                    let before = contract.get_spent_today(id("usdc.near")).0;
                    let accepted = ok(|| drop(contract.fund_agent(id("usdc.near"), U128(amount)))).is_some();
                    let expected = model::fund(limit, usage, amount, now);
                    prop_assert_eq!(accepted, expected.is_ok(), "contract and model disagree on an order of {}", amount);
                    if let Ok(next) = expected {
                        prop_assert!(amount <= per_order, "an order above the per-order limit passed");
                        check_order_receipts(amount);
                        usage = Some(next);
                        pending.push(Pending { amount, day: model::day_of(now) });
                    } else {
                        prop_assert_eq!(contract.get_spent_today(id("usdc.near")).0, before);
                    }
                }
                Step::Callback { pick, outcome } => {
                    if pending.is_empty() {
                        continue;
                    }
                    let order = pending.remove(pick % pending.len());
                    let (moved, result) = match outcome {
                        TokenOutcome::Moved(pct) => {
                            let moved = order.amount * u128::from(pct) / 100;
                            (moved, Ok(U128(moved)))
                        }
                        TokenOutcome::FailedNothingMoved => (0, Err(PromiseError::Failed)),
                        TokenOutcome::FailedAfterMoving => (order.amount, Err(PromiseError::Failed)),
                        TokenOutcome::OverReported(extra) => (order.amount, Ok(U128(order.amount + extra))),
                    };
                    call_from("user.near", 0, now);
                    let model_result = result.as_ref().ok().map(|v| v.0);
                    let used = contract.on_fund_resolved(id("usdc.near"), U128(order.amount), order.day, result);
                    let (model_used, next) = model::resolve(usage, order.amount, order.day, model_result);
                    prop_assert_eq!(used.0, model_used);
                    prop_assert!(used.0 <= order.amount);
                    usage = next;
                    *received.entry(order.day).or_default() += moved;
                }
                Step::Wait { nanos } => {
                    now = now.saturating_add(nanos);
                }
            }
            call_from("stranger.near", 0, now);
            prop_assert_eq!(contract.get_spent_today(id("usdc.near")).0, model::spent_on(usage, model::day_of(now)));
            prop_assert!(contract.get_spent_today(id("usdc.near")).0 <= per_day);
        }
        // Orders still in flight count as fully received.
        for order in &pending {
            *received.entry(order.day).or_default() += order.amount;
        }
        for (day, total) in &received {
            prop_assert!(*total <= per_day, "day {}: the agent received {} with a daily limit of {}", day, total, per_day);
        }
        // Any two consecutive calendar days together stay within twice the daily limit.
        for (day, total) in &received {
            let next = received.get(&(day + 1)).copied().unwrap_or(0);
            prop_assert!(total + next <= 2 * per_day);
        }
    }

    #[test]
    fn nobody_but_the_account_itself_can_change_anything(caller in "[a-z]{2,20}\\.near", deposit in prop_oneof![Just(0u128), Just(1u128), 2u128..1_000], amount in 0u128..1_000, per_order in 1u128..1_000) {
        prop_assume!(caller != "user.near");
        quiet_panics();
        call_from("user.near", 0, 1);
        let mut contract = SpendingLimits::new(id("intents.near"), id("agent.near"));
        call_from("user.near", 1, 1);
        contract.set_limit(id("usdc.near"), U128(500), U128(1_000));

        call_from(&caller, deposit, 2);
        prop_assert!(ok(|| drop(contract.fund_agent(id("usdc.near"), U128(amount)))).is_none());
        prop_assert!(ok(|| contract.set_agent(id(&caller))).is_none());
        prop_assert!(ok(|| contract.set_limit(id("usdc.near"), U128(per_order), U128(per_order))).is_none());
        prop_assert!(ok(|| contract.remove_limit(id("usdc.near"))).is_none());
        prop_assert!(ok(|| drop(SpendingLimits::new(id("intents.near"), id(&caller)))).is_none());
        let _ = contract.ft_on_transfer(id(&caller), U128(amount), String::new());

        prop_assert_eq!(contract.get_config().agent, id("agent.near"));
        prop_assert_eq!(contract.get_config().intents, id("intents.near"));
        let limit = contract.get_limit(id("usdc.near")).unwrap();
        prop_assert_eq!((limit.per_order.0, limit.per_day.0), (500, 1_000));
        prop_assert_eq!(contract.get_spent_today(id("usdc.near")).0, 0);
    }
}
