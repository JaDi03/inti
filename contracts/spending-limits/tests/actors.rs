//! Spending Limits against every kind of caller, in a mocked NEAR environment.
//!
//! The account that runs the contract is `user.near`. Inti's function-call key and the
//! user's full-access key both sign as `user.near`, so in this environment they look the
//! same: what tells them apart on-chain (method list of the key, deposits) is covered by
//! the sandbox tests. Methods are called directly here, so checks that live in the
//! generated wasm entry points (`#[private]`, no-deposit, init once) are not exercised.

use inti_spending_limits::{SpendingLimits, TokenLimit};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseOrValue};
use std::panic::{catch_unwind, AssertUnwindSafe};

const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn user() -> AccountId {
    id("user.near")
}
fn usdc() -> AccountId {
    id("usdc.near")
}
fn intents() -> AccountId {
    id("intents.near")
}
fn agent() -> AccountId {
    id("agent.near")
}
fn stranger() -> AccountId {
    id("stranger.near")
}

fn day_start(day: u64) -> u64 {
    day * NANOS_PER_DAY
}

/// Sets who calls (predecessor), who signed the transaction, the deposit and the block time.
fn call_from(predecessor: AccountId, signer: AccountId, deposit_yocto: u128, timestamp: u64) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(user())
        .predecessor_account_id(predecessor)
        .signer_account_id(signer)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .block_timestamp(timestamp);
    testing_env!(builder.build());
}

/// A call signed by a key on the user's own account.
fn own_call(deposit_yocto: u128, timestamp: u64) {
    call_from(user(), user(), deposit_yocto, timestamp);
}

fn installed(per_order: u128, per_day: u128) -> SpendingLimits {
    own_call(0, day_start(1) + 1);
    let mut contract = SpendingLimits::new(intents(), agent());
    own_call(1, day_start(1) + 1);
    contract.set_limit(usdc(), U128(per_order), U128(per_day));
    own_call(0, day_start(1) + 1);
    contract
}

/// Runs `f` and returns its panic message, or None when it did not panic.
fn panic_message<F: FnOnce()>(f: F) -> Option<String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(()) => None,
        Err(payload) => Some(
            payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default(),
        ),
    }
}

fn assert_panics_with<F: FnOnce()>(f: F, expected: &str) {
    let message = panic_message(f).expect("expected a panic");
    assert!(
        message.contains(expected),
        "panic `{message}` does not contain `{expected}`"
    );
}

/// One function call found in the receipts created by the last call.
struct CreatedCall {
    receiver: AccountId,
    method: String,
    args: Value,
    deposit: NearToken,
    gas: Gas,
}

fn created_calls() -> Vec<CreatedCall> {
    let mut calls = Vec::new();
    for receipt in get_created_receipts() {
        for action in &receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } = action
            {
                calls.push(CreatedCall {
                    receiver: receipt.receiver_id.clone(),
                    method: String::from_utf8(method_name.clone()).unwrap(),
                    args: near_sdk::serde_json::from_slice(args).unwrap(),
                    deposit: *attached_deposit,
                    gas: *prepaid_gas,
                });
            } else {
                panic!("unexpected action in a created receipt: {action:?}");
            }
        }
    }
    calls
}

// ---------- Owner, honest ----------

#[test]
fn owner_sets_a_limit_and_reads_it_back() {
    let contract = installed(100, 300);
    assert_eq!(
        contract.get_limit(usdc()),
        Some(TokenLimit {
            per_order: U128(100),
            per_day: U128(300)
        })
    );
    assert_eq!(contract.get_limit(id("other.near")), None);
    let config = contract.get_config();
    assert_eq!(config.intents, intents());
    assert_eq!(config.agent, agent());
}

#[test]
fn owner_removes_a_limit_and_the_token_can_no_longer_be_sent() {
    let mut contract = installed(100, 300);
    own_call(1, day_start(1) + 2);
    contract.remove_limit(usdc());
    assert_eq!(contract.get_limit(usdc()), None);
    own_call(0, day_start(1) + 3);
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(10))),
        "token not allowed",
    );
}

#[test]
fn owner_changes_the_agent_and_the_next_order_goes_to_the_new_agent() {
    let mut contract = installed(100, 300);
    own_call(1, day_start(1) + 2);
    contract.set_agent(id("new-agent.near"));
    assert_eq!(contract.get_config().agent, id("new-agent.near"));
    own_call(0, day_start(1) + 3);
    drop(contract.fund_agent(usdc(), U128(10)));
    let calls = created_calls();
    assert_eq!(calls[0].args["msg"], json!("new-agent.near"));
}

#[test]
fn owner_can_set_per_order_equal_to_per_day() {
    let contract = installed(100, 100);
    assert_eq!(contract.get_limit(usdc()).unwrap().per_order, U128(100));
}

#[test]
fn owner_cannot_set_a_zero_per_order_limit() {
    own_call(0, day_start(1));
    let mut contract = SpendingLimits::new(intents(), agent());
    own_call(1, day_start(1));
    assert_panics_with(
        || contract.set_limit(usdc(), U128(0), U128(10)),
        "per_order must be positive",
    );
}

// ---------- Owner, mistaken ----------

#[test]
fn owner_methods_reject_any_deposit_other_than_one_yocto() {
    let mut contract = installed(100, 300);
    for deposit in [0u128, 2, 1_000_000_000_000_000_000_000_000] {
        own_call(deposit, day_start(1) + 2);
        assert_panics_with(
            || contract.set_limit(usdc(), U128(1), U128(1)),
            "exactly 1 yoctoNEAR",
        );
        assert_panics_with(|| contract.remove_limit(usdc()), "exactly 1 yoctoNEAR");
        assert_panics_with(|| contract.set_agent(stranger()), "exactly 1 yoctoNEAR");
    }
    assert_eq!(
        contract.get_limit(usdc()),
        Some(TokenLimit {
            per_order: U128(100),
            per_day: U128(300)
        })
    );
    assert_eq!(contract.get_config().agent, agent());
}

#[test]
fn lowering_the_daily_limit_below_todays_spending_stops_further_orders_today() {
    let mut contract = installed(100, 300);
    drop(contract.fund_agent(usdc(), U128(100)));
    own_call(1, day_start(1) + 2);
    contract.set_limit(usdc(), U128(50), U128(50));
    own_call(0, day_start(1) + 3);
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(1))),
        "over the daily limit",
    );
}

#[test]
fn removing_and_adding_back_a_limit_keeps_todays_spending_counted() {
    let mut contract = installed(100, 100);
    drop(contract.fund_agent(usdc(), U128(100)));
    own_call(1, day_start(1) + 2);
    contract.remove_limit(usdc());
    contract.set_limit(usdc(), U128(100), U128(100));
    own_call(0, day_start(1) + 3);
    assert_eq!(contract.get_spent_today(usdc()), U128(100));
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(1))),
        "over the daily limit",
    );
}

// ---------- Agent (Inti's key), honest ----------

#[test]
fn an_order_sends_exactly_one_transfer_to_the_verifier_for_the_agent() {
    let mut contract = installed(100, 300);
    drop(contract.fund_agent(usdc(), U128(42)));
    let calls = created_calls();
    assert_eq!(calls.len(), 2, "one token call and one callback");

    let transfer = &calls[0];
    assert_eq!(transfer.receiver, usdc());
    assert_eq!(transfer.method, "ft_transfer_call");
    assert_eq!(
        transfer.args,
        json!({ "receiver_id": "intents.near", "amount": "42", "memo": null, "msg": "agent.near" })
    );
    assert_eq!(transfer.deposit, NearToken::from_yoctonear(1));
    assert_eq!(transfer.gas, Gas::from_tgas(60));

    let callback = &calls[1];
    assert_eq!(callback.receiver, user());
    assert_eq!(callback.method, "on_fund_resolved");
    assert_eq!(
        callback.args,
        json!({ "token": "usdc.near", "amount": "42", "day": 1 })
    );
    assert_eq!(callback.deposit, NearToken::from_yoctonear(0));
    assert_eq!(callback.gas, Gas::from_tgas(10));
}

#[test]
fn an_order_of_zero_is_refused() {
    let mut contract = installed(100, 300);
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(0))),
        "amount must be positive",
    );
    assert_eq!(contract.get_spent_today(usdc()), U128(0));
}

#[test]
fn an_order_of_exactly_the_per_order_limit_is_accepted() {
    let mut contract = installed(100, 300);
    drop(contract.fund_agent(usdc(), U128(100)));
    assert_eq!(contract.get_spent_today(usdc()), U128(100));
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(101))),
        "over the per-order limit",
    );
}

#[test]
fn orders_up_to_exactly_the_daily_limit_pass_and_one_more_unit_is_refused() {
    let mut contract = installed(100, 250);
    drop(contract.fund_agent(usdc(), U128(100)));
    drop(contract.fund_agent(usdc(), U128(100)));
    drop(contract.fund_agent(usdc(), U128(50)));
    assert_eq!(contract.get_spent_today(usdc()), U128(250));
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(1))),
        "over the daily limit",
    );
    assert_eq!(contract.get_spent_today(usdc()), U128(250));
}

#[test]
fn a_refund_from_the_verifier_frees_only_that_order() {
    let mut contract = installed(100, 200);
    drop(contract.fund_agent(usdc(), U128(100)));
    drop(contract.fund_agent(usdc(), U128(100)));
    // The second order was fully refunded by the receiver.
    let used = contract.on_fund_resolved(usdc(), U128(100), 1, Ok(U128(0)));
    assert_eq!(used, U128(0));
    assert_eq!(contract.get_spent_today(usdc()), U128(100));
    // The first order was fully used.
    let used = contract.on_fund_resolved(usdc(), U128(100), 1, Ok(U128(100)));
    assert_eq!(used, U128(100));
    assert_eq!(contract.get_spent_today(usdc()), U128(100));
}

/// Limits as large as the type allows: the daily count never wraps around to let more through.
#[test]
fn the_largest_possible_limits_never_wrap_around() {
    let mut contract = installed(u128::MAX, u128::MAX);
    drop(contract.fund_agent(usdc(), U128(u128::MAX)));
    assert_eq!(contract.get_spent_today(usdc()), U128(u128::MAX));
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(1))),
        "amount overflow",
    );
    assert_eq!(contract.get_spent_today(usdc()), U128(u128::MAX));
}

// ---------- Agent key stolen ----------

#[test]
fn a_stolen_key_sending_in_a_loop_stops_at_the_daily_limit() {
    let mut contract = installed(7, 50);
    let mut sent = 0u128;
    for step in 0..100u64 {
        own_call(0, day_start(1) + 1 + step);
        match panic_message(|| drop(contract.fund_agent(usdc(), U128(7)))) {
            None => sent += 7,
            Some(message) => assert!(message.contains("over the daily limit"), "{message}"),
        }
    }
    assert_eq!(sent, 49);
    assert_eq!(contract.get_spent_today(usdc()), U128(49));
}

#[test]
fn a_late_callback_from_yesterday_does_not_free_todays_budget() {
    let mut contract = installed(100, 100);
    own_call(0, day_start(1) + 5);
    drop(contract.fund_agent(usdc(), U128(100)));
    own_call(0, day_start(2) + 5);
    drop(contract.fund_agent(usdc(), U128(100)));
    // Yesterday's order is refunded only now.
    let used = contract.on_fund_resolved(usdc(), U128(100), 1, Ok(U128(0)));
    assert_eq!(used, U128(0));
    assert_eq!(contract.get_spent_today(usdc()), U128(100));
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(1))),
        "over the daily limit",
    );
}

#[test]
fn a_callback_never_frees_more_than_its_own_order() {
    let mut contract = installed(100, 100);
    drop(contract.fund_agent(usdc(), U128(60)));
    let used = contract.on_fund_resolved(usdc(), U128(60), 1, Ok(U128(u128::MAX)));
    assert_eq!(used, U128(60));
    assert_eq!(contract.get_spent_today(usdc()), U128(60));
}

// ---------- Stranger and any other contract ----------

#[test]
fn a_stranger_cannot_call_any_method_that_changes_state() {
    let mut contract = installed(100, 300);
    for deposit in [0u128, 1] {
        call_from(stranger(), stranger(), deposit, day_start(1) + 2);
        assert_panics_with(
            || drop(contract.fund_agent(usdc(), U128(1))),
            "only this account",
        );
        if deposit == 1 {
            assert_panics_with(|| contract.set_agent(stranger()), "only this account");
            assert_panics_with(
                || contract.set_limit(usdc(), U128(1000), U128(1000)),
                "only this account",
            );
            assert_panics_with(|| contract.remove_limit(usdc()), "only this account");
        }
        assert_panics_with(
            || drop(SpendingLimits::new(intents(), stranger())),
            "only this account",
        );
    }
    own_call(0, day_start(1) + 3);
    assert_eq!(contract.get_config().agent, agent());
    assert_eq!(
        contract.get_limit(usdc()),
        Some(TokenLimit {
            per_order: U128(100),
            per_day: U128(300)
        })
    );
    assert_eq!(contract.get_spent_today(usdc()), U128(0));
}

/// The check uses the direct caller, not the signer: a contract the user calls cannot act
/// on the user's account even though the user signed the transaction.
#[test]
fn a_contract_the_user_calls_cannot_act_on_the_users_account() {
    let mut contract = installed(100, 300);
    call_from(id("some-dapp.near"), user(), 0, day_start(1) + 2);
    assert_panics_with(
        || drop(contract.fund_agent(usdc(), U128(1))),
        "only this account",
    );
    call_from(id("some-dapp.near"), user(), 1, day_start(1) + 2);
    assert_panics_with(|| contract.set_agent(stranger()), "only this account");
}

#[test]
fn incoming_token_transfers_from_anyone_are_accepted_and_change_nothing() {
    let mut contract = installed(100, 300);
    call_from(id("any-token.near"), stranger(), 0, day_start(1) + 2);
    match contract.ft_on_transfer(stranger(), U128(5), "anything".to_string()) {
        PromiseOrValue::Value(unused) => assert_eq!(unused, U128(0)),
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
    assert!(get_created_receipts().is_empty());
    assert_eq!(contract.get_config().agent, agent());
    assert_eq!(
        contract.get_limit(usdc()),
        Some(TokenLimit {
            per_order: U128(100),
            per_day: U128(300)
        })
    );
    assert_eq!(contract.get_spent_today(usdc()), U128(0));
}
