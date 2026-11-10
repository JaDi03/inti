//! Spending Limits on a local NEAR sandbox, with the same activation the app signs
//! (deploy + new + set_limit + Inti's function-call key, in one transaction), a real
//! NEP-141 token from near-contract-standards, and a stand-in for the NEAR Intents
//! verifier. These tests show what unit tests cannot: access-key rules, `#[private]`,
//! deposits, failed promises and callbacks, gas, and orders in flight at the same time.
//!
//! The contract wasm path comes from `SPENDING_LIMITS_WASM` and the mock wasm path from
//! `MOCK_FT_WASM`; both are required, so the tests never run against a stale build.

use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, PublicKey, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const SUPPLY: u128 = 1_000_000;

fn contract_wasm() -> Vec<u8> {
    let path = std::env::var("SPENDING_LIMITS_WASM")
        .expect("set SPENDING_LIMITS_WASM to the contract wasm built from this code");
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

fn mock_wasm() -> Vec<u8> {
    let path = std::env::var("MOCK_FT_WASM").expect("set MOCK_FT_WASM to the built mock-ft wasm");
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

struct Setup {
    worker: Worker<Sandbox>,
    /// The user's account signing with its full-access key.
    user: Account,
    /// The same account signing with Inti's function-call key.
    inti: Account,
    inti_key: PublicKey,
    token: Contract,
    intents: Contract,
    agent: AccountId,
    stranger: Account,
}

async fn setup(per_order: u128, per_day: u128) -> anyhow::Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let new_account = |name: &'static str| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(30))
                .transact()
                .await?
                .into_result()
                .map_err(anyhow::Error::from)
        }
    };
    let user = new_account("user").await?;
    let stranger = new_account("stranger").await?;
    let token = new_account("token")
        .await?
        .deploy(&mock_wasm())
        .await?
        .into_result()?;
    let intents = new_account("intents")
        .await?
        .deploy(&mock_wasm())
        .await?
        .into_result()?;
    let agent: AccountId = "agent.test.near".parse()?;

    token
        .call("new")
        .args_json(json!({ "owner_id": user.id(), "total_supply": SUPPLY.to_string() }))
        .transact()
        .await?
        .into_result()?;
    intents
        .call("new")
        .args_json(json!({ "owner_id": intents.id(), "total_supply": "0" }))
        .transact()
        .await?
        .into_result()?;
    for account in [intents.id(), stranger.id()] {
        token
            .call("register")
            .args_json(json!({ "account_id": account }))
            .transact()
            .await?
            .into_result()?;
    }

    // Activation, as `LimitsClient.activate` builds it.
    let secret = SecretKey::from_random(KeyType::ED25519);
    let inti_key = secret.public_key();
    let activation = user
        .batch(user.id())
        .deploy(&contract_wasm())
        .call(Function::new("new").args_json(json!({ "intents": intents.id(), "agent": agent })).gas(Gas::from_tgas(30)))
        .call(
            Function::new("set_limit")
                .args_json(json!({ "token": token.id(), "per_order": per_order.to_string(), "per_day": per_day.to_string() }))
                .deposit(NearToken::from_yoctonear(1))
                .gas(Gas::from_tgas(30)),
        )
        .add_key(inti_key.clone(), AccessKey::function_call_access(user.id(), &["fund_agent"], Some(NearToken::from_millinear(250))))
        .transact()
        .await?;
    assert!(activation.is_success(), "activation failed: {activation:?}");
    let inti = Account::from_secret_key(user.id().clone(), secret, &worker);
    Ok(Setup {
        worker,
        user,
        inti,
        inti_key,
        token,
        intents,
        agent,
        stranger,
    })
}

impl Setup {
    async fn fund_with(
        &self,
        signer: &Account,
        amount: u128,
        gas_tgas: u64,
    ) -> near_workspaces::Result<ExecutionFinalResult> {
        signer
            .call(self.user.id(), "fund_agent")
            .args_json(json!({ "token": self.token.id(), "amount": amount.to_string() }))
            .gas(Gas::from_tgas(gas_tgas))
            .transact()
            .await
    }

    async fn fund(&self, amount: u128) -> near_workspaces::Result<ExecutionFinalResult> {
        self.fund_with(&self.inti, amount, 150).await
    }

    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self
            .worker
            .view(contract, method)
            .args_json(args)
            .await?
            .json::<Value>()?)
    }

    async fn spent_last_24h(&self) -> anyhow::Result<u128> {
        let value = self
            .view(
                self.user.id(),
                "get_spent_last_24h",
                json!({ "token": self.token.id() }),
            )
            .await?;
        Ok(value.as_str().unwrap().parse()?)
    }

    async fn balance(&self, account: &AccountId) -> anyhow::Result<u128> {
        let value = self
            .view(
                self.token.id(),
                "ft_balance_of",
                json!({ "account_id": account }),
            )
            .await?;
        Ok(value.as_str().unwrap().parse()?)
    }

    async fn set_modes(
        &self,
        contract: &Contract,
        token_mode: &str,
        receiver_mode: &str,
    ) -> anyhow::Result<()> {
        contract
            .call("set_modes")
            .args_json(json!({ "token_mode": token_mode, "receiver_mode": receiver_mode }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn key_count(&self) -> anyhow::Result<usize> {
        Ok(self.worker.view_access_keys(self.user.id()).await?.len())
    }
}

/// The value returned by `fund_agent`'s last receipt (the callback): the amount used.
fn used(result: &ExecutionFinalResult) -> u128 {
    result
        .clone()
        .json::<String>()
        .expect("callback returned an amount")
        .parse()
        .unwrap()
}

/// Describes how a call that must not run was stopped; panics if it ran.
fn refused(outcome: near_workspaces::Result<ExecutionFinalResult>) -> String {
    match outcome {
        Err(error) => format!("rejected before execution: {error:?}"),
        Ok(result) if result.is_failure() => {
            format!("failed: {:?}", result.into_result().unwrap_err())
        }
        Ok(result) => panic!("expected a refusal, got a success: {result:?}"),
    }
}

fn assert_contains(text: &str, expected: &str) {
    assert!(
        text.contains(expected),
        "`{text}` does not contain `{expected}`"
    );
}

/// Gas burnt by each receipt, in execution order: (executor, Tgas).
fn receipt_gas(result: &ExecutionFinalResult) -> Vec<(String, f64)> {
    result
        .receipt_outcomes()
        .iter()
        .map(|outcome| {
            (
                outcome.executor_id.to_string(),
                outcome.gas_burnt.as_gas() as f64 / 1e12,
            )
        })
        .collect()
}

#[tokio::test]
async fn inti_key_funds_the_agent_within_limits_and_nowhere_else() -> anyhow::Result<()> {
    let s = setup(100, 250).await?;
    let first = s.fund(100).await?;
    assert!(first.is_success(), "{first:?}");
    assert_eq!(used(&first), 100);
    println!("receipt gas of one order: {:?}", receipt_gas(&first));

    assert_eq!(s.balance(s.intents.id()).await?, 100);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY - 100);
    let received = s.view(s.intents.id(), "last_received", json!({})).await?;
    assert_eq!(received["token"], json!(s.token.id()));
    assert_eq!(received["sender_id"], json!(s.user.id()));
    assert_eq!(received["msg"], json!(s.agent));
    assert_eq!(received["amount"], json!("100"));
    assert_eq!(s.spent_last_24h().await?, 100);

    assert!(s.fund(100).await?.is_success());
    let over_day = refused(s.fund(100).await);
    assert_contains(&over_day, "over the daily limit");
    let over_order = refused(s.fund(101).await);
    assert_contains(&over_order, "over the per-order limit");
    assert_eq!(s.balance(s.intents.id()).await?, 200);
    assert_eq!(s.spent_last_24h().await?, 200);
    Ok(())
}

#[tokio::test]
async fn inti_key_cannot_do_anything_but_fund_agent() -> anyhow::Result<()> {
    let s = setup(100, 250).await?;
    let user_id = s.user.id().clone();
    let token_args = json!({ "token": s.token.id(), "per_order": "1000000", "per_day": "1000000" });
    let attempts = vec![
        (
            "set_limit",
            refused(
                s.inti
                    .call(&user_id, "set_limit")
                    .args_json(token_args.clone())
                    .transact()
                    .await,
            ),
        ),
        (
            "set_limit with 1 yocto",
            refused(
                s.inti
                    .call(&user_id, "set_limit")
                    .args_json(token_args.clone())
                    .deposit(NearToken::from_yoctonear(1))
                    .transact()
                    .await,
            ),
        ),
        (
            "set_agent",
            refused(
                s.inti
                    .call(&user_id, "set_agent")
                    .args_json(json!({ "agent": s.stranger.id() }))
                    .transact()
                    .await,
            ),
        ),
        (
            "remove_limit",
            refused(
                s.inti
                    .call(&user_id, "remove_limit")
                    .args_json(json!({ "token": s.token.id() }))
                    .transact()
                    .await,
            ),
        ),
        (
            "on_fund_resolved",
            refused(
                s.inti
                    .call(&user_id, "on_fund_resolved")
                    .args_json(json!({ "token": s.token.id(), "amount": "100", "order_id": 0 }))
                    .transact()
                    .await,
            ),
        ),
        (
            "fund_agent with 1 yocto",
            refused(
                s.inti
                    .call(&user_id, "fund_agent")
                    .args_json(json!({ "token": s.token.id(), "amount": "1" }))
                    .deposit(NearToken::from_yoctonear(1))
                    .transact()
                    .await,
            ),
        ),
        (
            "token ft_transfer to a stranger",
            refused(
                s.inti
                    .call(s.token.id(), "ft_transfer")
                    .args_json(json!({ "receiver_id": s.stranger.id(), "amount": "1" }))
                    .deposit(NearToken::from_yoctonear(1))
                    .transact()
                    .await,
            ),
        ),
        (
            "call on the token contract",
            refused(
                s.inti
                    .call(s.token.id(), "fund_agent")
                    .args_json(json!({ "token": s.token.id(), "amount": "1" }))
                    .transact()
                    .await,
            ),
        ),
        (
            "NEAR transfer of 1 yocto",
            refused(
                s.inti
                    .batch(&user_id)
                    .transfer(NearToken::from_yoctonear(1))
                    .transact()
                    .await,
            ),
        ),
        (
            "add a full-access key",
            refused(
                s.inti
                    .batch(&user_id)
                    .add_key(
                        SecretKey::from_random(KeyType::ED25519).public_key(),
                        AccessKey::full_access(),
                    )
                    .transact()
                    .await,
            ),
        ),
        (
            "delete its own key",
            refused(
                s.inti
                    .batch(&user_id)
                    .delete_key(s.inti_key.clone())
                    .transact()
                    .await,
            ),
        ),
        (
            "deploy code",
            refused(s.inti.batch(&user_id).deploy(&mock_wasm()).transact().await),
        ),
        (
            "delete the account",
            refused(
                s.inti
                    .batch(&user_id)
                    .delete_account(s.stranger.id())
                    .transact()
                    .await,
            ),
        ),
    ];
    let expected = [
        ("set_limit", "MethodNameMismatch"),
        ("set_limit with 1 yocto", "DepositWithFunctionCall"),
        ("set_agent", "MethodNameMismatch"),
        ("remove_limit", "MethodNameMismatch"),
        ("on_fund_resolved", "MethodNameMismatch"),
        ("fund_agent with 1 yocto", "DepositWithFunctionCall"),
        ("token ft_transfer to a stranger", "DepositWithFunctionCall"),
        ("call on the token contract", "ReceiverMismatch"),
        ("NEAR transfer of 1 yocto", "RequiresFullAccess"),
        ("add a full-access key", "RequiresFullAccess"),
        ("delete its own key", "RequiresFullAccess"),
        ("deploy code", "RequiresFullAccess"),
        ("delete the account", "RequiresFullAccess"),
    ];
    assert_eq!(attempts.len(), expected.len());
    for ((what, how), (name, kind)) in attempts.iter().zip(expected) {
        println!("Inti key, {what}: {how}");
        assert_eq!(*what, name);
        assert_contains(how, kind);
    }
    let limit = s
        .view(&user_id, "get_limit", json!({ "token": s.token.id() }))
        .await?;
    assert_eq!(limit, json!({ "per_order": "100", "per_day": "250" }));
    let config = s.view(&user_id, "get_config", json!({})).await?;
    assert_eq!(config["agent"], json!(s.agent));
    assert_eq!(s.key_count().await?, 2);
    assert_eq!(s.balance(s.stranger.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn strangers_cannot_change_anything_or_fake_a_callback() -> anyhow::Result<()> {
    let s = setup(100, 250).await?;
    let user_id = s.user.id().clone();
    let fund = refused(
        s.stranger
            .call(&user_id, "fund_agent")
            .args_json(json!({ "token": s.token.id(), "amount": "1" }))
            .transact()
            .await,
    );
    assert_contains(&fund, "only this account can call this method");
    let limit = refused(
        s.stranger
            .call(&user_id, "set_limit")
            .args_json(json!({ "token": s.token.id(), "per_order": "9", "per_day": "9" }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await,
    );
    assert_contains(&limit, "only this account can call this method");
    let agent = refused(
        s.stranger
            .call(&user_id, "set_agent")
            .args_json(json!({ "agent": s.stranger.id() }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await,
    );
    assert_contains(&agent, "only this account can call this method");
    let init = refused(
        s.stranger
            .call(&user_id, "new")
            .args_json(json!({ "intents": s.stranger.id(), "agent": s.stranger.id() }))
            .transact()
            .await,
    );
    assert_contains(&init, "already been initialized");
    let callback = refused(
        s.stranger
            .call(&user_id, "on_fund_resolved")
            .args_json(json!({ "token": s.token.id(), "amount": "100", "order_id": 0 }))
            .transact()
            .await,
    );
    assert_contains(&callback, "Method on_fund_resolved is private");

    let incoming = s
        .stranger
        .call(&user_id, "ft_on_transfer")
        .args_json(json!({ "sender_id": s.stranger.id(), "amount": "5", "msg": "" }))
        .transact()
        .await?;
    assert!(incoming.is_success());
    assert_eq!(incoming.json::<String>()?, "0");

    assert_eq!(
        s.view(&user_id, "get_limit", json!({ "token": s.token.id() }))
            .await?,
        json!({ "per_order": "100", "per_day": "250" })
    );
    assert_eq!(
        s.view(&user_id, "get_config", json!({})).await?["agent"],
        json!(s.agent)
    );
    assert_eq!(s.spent_last_24h().await?, 0);
    Ok(())
}

#[tokio::test]
async fn the_contract_cannot_be_initialized_twice() -> anyhow::Result<()> {
    let s = setup(100, 250).await?;
    let again = refused(
        s.user
            .call(s.user.id(), "new")
            .args_json(json!({ "intents": s.stranger.id(), "agent": s.stranger.id() }))
            .transact()
            .await,
    );
    assert_contains(&again, "already been initialized");
    assert_eq!(
        s.view(s.user.id(), "get_config", json!({})).await?["intents"],
        json!(s.intents.id())
    );
    Ok(())
}

#[tokio::test]
async fn a_refund_by_the_verifier_frees_the_budget() -> anyhow::Result<()> {
    let s = setup(100, 100).await?;
    s.set_modes(&s.intents, "standard", "refund").await?;
    let result = s.fund(100).await?;
    assert!(result.is_success(), "{result:?}");
    assert_eq!(used(&result), 0);
    assert_eq!(s.spent_last_24h().await?, 0);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY);
    s.set_modes(&s.intents, "standard", "accept").await?;
    assert!(s.fund(100).await?.is_success());
    assert_eq!(s.balance(s.intents.id()).await?, 100);
    Ok(())
}

#[tokio::test]
async fn a_failing_verifier_frees_the_budget() -> anyhow::Result<()> {
    let s = setup(100, 100).await?;
    s.set_modes(&s.intents, "standard", "panic").await?;
    let result = s.fund(100).await?;
    assert!(result.is_success(), "{result:?}");
    assert_eq!(used(&result), 0);
    assert_eq!(s.spent_last_24h().await?, 0);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY);
    Ok(())
}

/// A token result that is not an amount makes the callback itself fail; the reservation
/// stays, so the limit errs on the safe side.
#[tokio::test]
async fn a_malformed_token_result_keeps_the_budget_used() -> anyhow::Result<()> {
    let s = setup(100, 100).await?;
    s.set_modes(&s.token, "garbage", "accept").await?;
    let result = s.fund(100).await?;
    let failure = format!("{:?}", result.receipt_failures());
    println!("callback failure: {failure}");
    assert_contains(&failure, "Failed to deserialize callback");
    assert_eq!(s.spent_last_24h().await?, 100);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY);
    Ok(())
}

/// A token result longer than 64 bytes is not read: the callback runs and counts the full
/// order, so the limit errs on the safe side.
#[tokio::test]
async fn a_token_result_longer_than_64_bytes_counts_the_full_order() -> anyhow::Result<()> {
    let s = setup(100, 100).await?;
    s.set_modes(&s.token, "too_long", "accept").await?;
    let result = s.fund(100).await?;
    assert!(result.is_success(), "{:?}", result.receipt_failures());
    assert_eq!(used(&result), 100);
    assert_eq!(s.spent_last_24h().await?, 100);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY);
    Ok(())
}

#[tokio::test]
async fn every_order_logs_its_sent_and_resolved_events() -> anyhow::Result<()> {
    let s = setup(100, 100).await?;
    let result = s.fund(40).await?;
    assert!(result.is_success(), "{:?}", result.receipt_failures());
    let events: Vec<Value> = result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).unwrap())
        .filter(|event: &Value| event["standard"] == "inti_spending_limits")
        .collect();
    let names: Vec<&str> = events
        .iter()
        .map(|event| event["event"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["order_sent", "order_resolved"], "{events:?}");
    assert_eq!(events[0]["data"][0]["amount"], "40");
    assert_eq!(events[1]["data"][0]["used"], "40");
    Ok(())
}

#[tokio::test]
async fn the_25th_order_in_24_hours_is_refused() -> anyhow::Result<()> {
    let s = setup(1, 1_000).await?;
    // The full-access key signs, so the 25 orders do not depend on Inti's gas allowance.
    for order in 1..=24 {
        let result = s.fund_with(&s.user, 1, 80).await?;
        assert!(
            result.is_success(),
            "order {order}: {:?}",
            result.receipt_failures()
        );
    }
    let refused_order = refused(s.fund_with(&s.user, 1, 80).await);
    assert_contains(&refused_order, "over the daily number of orders");
    assert_eq!(s.spent_last_24h().await?, 24);
    assert_eq!(s.balance(s.intents.id()).await?, 24);
    Ok(())
}

#[tokio::test]
async fn two_orders_in_flight_never_pass_the_daily_limit() -> anyhow::Result<()> {
    let s = setup(10, 15).await?;
    // A second key with the same permission, so the two orders are separate transactions
    // in flight at the same time.
    let second_secret = SecretKey::from_random(KeyType::ED25519);
    s.user
        .batch(s.user.id())
        .add_key(
            second_secret.public_key(),
            AccessKey::function_call_access(
                s.user.id(),
                &["fund_agent"],
                Some(NearToken::from_millinear(250)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let second = Account::from_secret_key(s.user.id().clone(), second_secret, &s.worker);

    let (a, b) = tokio::join!(s.fund_with(&s.inti, 10, 150), s.fund_with(&second, 10, 150));
    let outcomes = [a?, b?];
    let passed = outcomes.iter().filter(|r| r.is_success()).count();
    for outcome in &outcomes {
        println!(
            "concurrent order: success={} failures={:?}",
            outcome.is_success(),
            outcome.receipt_failures().len()
        );
    }
    assert_eq!(passed, 1);
    assert_eq!(s.balance(s.intents.id()).await?, 10);
    assert_eq!(s.spent_last_24h().await?, 10);
    Ok(())
}

#[tokio::test]
async fn too_little_gas_is_refused_before_the_order_counts() -> anyhow::Result<()> {
    let s = setup(100, 1_000).await?;
    for tgas in [50u64, 60, 70, 75, 79] {
        let low = refused(s.fund_with(&s.inti, 10, tgas).await);
        assert_contains(&low, "not enough gas for the order");
    }
    assert_eq!(s.spent_last_24h().await?, 0);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY);
    // Inti's key allows 0.25 NEAR of gas per transaction, so 150 Tgas is the most it can attach.
    for tgas in [80u64, 100, 150] {
        let result = s.fund_with(&s.inti, 10, tgas).await?;
        println!(
            "order with {tgas} Tgas: success={} failures={} receipts={:?}",
            result.is_success(),
            result.receipt_failures().len(),
            receipt_gas(&result)
        );
        assert!(result.is_success(), "order with {tgas} Tgas failed");
    }
    assert_eq!(s.spent_last_24h().await?, 30);
    assert_eq!(s.balance(s.intents.id()).await?, 30);
    Ok(())
}

#[tokio::test]
async fn the_full_access_key_removes_inti_and_can_replace_the_code() -> anyhow::Result<()> {
    let s = setup(100, 250).await?;
    s.user
        .batch(s.user.id())
        .delete_key(s.inti_key.clone())
        .transact()
        .await?
        .into_result()?;
    let after_delete = refused(s.fund(10).await);
    println!("Inti key after the owner deleted it: {after_delete}");
    assert_eq!(s.key_count().await?, 1);

    // The owner withdraws with a plain token transfer; the contract is not involved.
    s.user
        .call(s.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": s.stranger.id(), "amount": "500" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(s.balance(s.stranger.id()).await?, 500);

    // A full-access key can replace the code; the old state stays behind.
    s.user
        .batch(s.user.id())
        .deploy(&mock_wasm())
        .transact()
        .await?
        .into_result()?;
    let gone = s
        .worker
        .view(s.user.id(), "get_config")
        .args_json(json!({}))
        .await;
    println!(
        "get_config after the code was replaced: {:?}",
        gone.map(|r| r.result.len())
    );
    let state = s.worker.view_state(s.user.id()).await?;
    println!(
        "state keys left after the code was replaced: {}",
        state.len()
    );
    assert!(!state.is_empty());
    Ok(())
}

#[tokio::test]
async fn a_full_day_of_orders_burns_a_small_part_of_the_gas_allowance() -> anyhow::Result<()> {
    // Inti's own key, with the 0.25 NEAR allowance the app gives it, sending the smallest
    // orders with the least gas the contract accepts. Only the gas an order burns comes out of
    // the account, so the 24 orders of a day pass and the order cap stops the next one.
    let s = setup(1, 1_000_000).await?;
    let before = s.user.view_account().await?.balance.as_yoctonear() as i128;
    for order in 1..=24 {
        let result = s.fund_with(&s.inti, 1, 80).await?;
        assert!(
            result.is_success(),
            "order {order}: {:?}",
            result.receipt_failures()
        );
    }
    let refused_order = refused(s.fund_with(&s.inti, 1, 80).await);
    assert_contains(&refused_order, "over the daily number of orders");
    let after = s.user.view_account().await?.balance.as_yoctonear() as i128;
    let burned = before - after;
    println!("Inti key with 0.25 NEAR allowance: 24 orders of 80 Tgas burned {burned} yocto");
    let half_the_allowance = 125 * 10i128.pow(21);
    assert!(
        burned > 0 && burned < half_the_allowance,
        "burned {burned} yocto"
    );
    assert_eq!(s.spent_last_24h().await?, 24);
    Ok(())
}

/// The smallest valid wasm module: an empty contract with no methods.
const EMPTY_WASM: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/// "Release my money" as the app signs it: one transaction removes Inti's key and replaces the
/// contract with an empty module. The code's storage is released and that NEAR can leave.
#[tokio::test]
async fn the_owner_can_remove_spending_limits_and_free_its_storage() -> anyhow::Result<()> {
    let s = setup(100, 300).await?;
    let before = s.user.view_account().await?;

    let release = s
        .user
        .batch(s.user.id())
        .delete_key(s.inti_key.clone())
        .deploy(&EMPTY_WASM)
        .transact()
        .await?;
    assert!(release.is_success(), "release failed: {release:?}");

    let after = s.user.view_account().await?;
    let freed_bytes = before.storage_usage - after.storage_usage;
    println!(
        "storage_usage before={} after={} freed_bytes={} freed_near={}",
        before.storage_usage,
        after.storage_usage,
        freed_bytes,
        freed_bytes as f64 * 1e19 / 1e24
    );
    assert!(freed_bytes >= contract_wasm().len() as u64 - EMPTY_WASM.len() as u64);

    // Inti's key no longer works, and there is no fund_agent to call.
    let order = s
        .inti
        .call(s.user.id(), "fund_agent")
        .args_json(json!({ "token": s.token.id(), "amount": "1" }))
        .gas(Gas::from_tgas(80))
        .transact()
        .await;
    assert!(
        order.map(|r| !r.is_success()).unwrap_or(true),
        "Inti's key still acts"
    );

    // The released NEAR is spendable: send all but what the remaining storage and fees need.
    let locked = after.storage_usage as u128 * 10u128.pow(19);
    let spendable =
        after.balance.as_yoctonear() - locked - NearToken::from_millinear(10).as_yoctonear();
    let out = s
        .user
        .transfer_near(s.stranger.id(), NearToken::from_yoctonear(spendable))
        .await?;
    assert!(
        out.is_success(),
        "sending the released NEAR failed: {out:?}"
    );
    Ok(())
}
