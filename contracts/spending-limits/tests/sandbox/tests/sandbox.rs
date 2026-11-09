//! Spending Limits on a local NEAR sandbox, with the same activation the app signs
//! (deploy + new + set_limit + Inti's function-call key, in one transaction), a real
//! NEP-141 token from near-contract-standards, and a stand-in for the NEAR Intents
//! verifier. These tests show what unit tests cannot: access-key rules, `#[private]`,
//! deposits, failed promises and callbacks, gas, and orders in flight at the same time.
//!
//! The contract wasm is the file the app deploys (`web/public/inti-spending-limits.wasm`).
//! The mock wasm path comes from `MOCK_FT_WASM`.

use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, PublicKey, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const SUPPLY: u128 = 1_000_000;

fn contract_wasm() -> Vec<u8> {
    let path = std::env::var("SPENDING_LIMITS_WASM").unwrap_or_else(|_| {
        format!(
            "{}/../../../../web/public/inti-spending-limits.wasm",
            env!("CARGO_MANIFEST_DIR")
        )
    });
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

    async fn spent_today(&self) -> anyhow::Result<u128> {
        let value = self
            .view(
                self.user.id(),
                "get_spent_today",
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
    assert_eq!(s.spent_today().await?, 100);

    assert!(s.fund(100).await?.is_success());
    let over_day = refused(s.fund(100).await);
    assert_contains(&over_day, "over the daily limit");
    let over_order = refused(s.fund(101).await);
    assert_contains(&over_order, "over the per-order limit");
    assert_eq!(s.balance(s.intents.id()).await?, 200);
    assert_eq!(s.spent_today().await?, 200);
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
                    .args_json(json!({ "token": s.token.id(), "amount": "100", "day": 0 }))
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
            .args_json(json!({ "token": s.token.id(), "amount": "100", "day": 0 }))
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
    assert_eq!(s.spent_today().await?, 0);
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
    assert_eq!(s.spent_today().await?, 0);
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
    assert_eq!(s.spent_today().await?, 0);
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
    assert_eq!(s.spent_today().await?, 100);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY);
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
    assert_eq!(s.spent_today().await?, 10);
    Ok(())
}

#[tokio::test]
async fn too_little_gas_fails_the_order_and_counts_nothing() -> anyhow::Result<()> {
    let s = setup(100, 1_000).await?;
    let low = refused(s.fund_with(&s.inti, 10, 50).await);
    println!("order with 50 Tgas: {low}");
    assert_eq!(s.spent_today().await?, 0);
    assert_eq!(s.balance(s.user.id()).await?, SUPPLY);
    for tgas in [60u64, 70, 72, 75, 100, 300] {
        match s.fund_with(&s.inti, 10, tgas).await {
            Ok(result) => println!(
                "order with {tgas} Tgas: success={} failures={} receipts={:?}",
                result.is_success(),
                result.receipt_failures().len(),
                receipt_gas(&result)
            ),
            Err(error) => println!("order with {tgas} Tgas: rejected: {error:?}"),
        }
    }
    let spent = s.spent_today().await?;
    let moved = s.balance(s.intents.id()).await?;
    println!("after the gas sweep: spent today {spent}, received by the verifier {moved}");
    assert!(moved <= spent);
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
async fn the_gas_allowance_caps_what_a_stolen_key_can_burn() -> anyhow::Result<()> {
    let s = setup(1, 1_000_000).await?;
    let secret = SecretKey::from_random(KeyType::ED25519);
    s.user
        .batch(s.user.id())
        .add_key(
            secret.public_key(),
            AccessKey::function_call_access(
                s.user.id(),
                &["fund_agent"],
                Some(NearToken::from_millinear(50)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let small_key = secret.public_key();
    let small = Account::from_secret_key(s.user.id().clone(), secret, &s.worker);
    let before = s.user.view_account().await?.balance.as_yoctonear() as i128;
    let mut sent = 0;
    let mut stop = String::from("no refusal");
    for _ in 0..200 {
        match s.fund_with(&small, 1, 100).await {
            Ok(result) if result.is_success() => sent += 1,
            Ok(result) => {
                stop = format!("failed: {:?}", result.receipt_failures());
                break;
            }
            Err(error) => {
                stop = format!("rejected: {error:?}");
                break;
            }
        }
    }
    let after = s.user.view_account().await?.balance.as_yoctonear() as i128;
    let key = s.worker.view_access_key(s.user.id(), &small_key).await;
    println!(
        "key with 0.05 NEAR allowance: {sent} orders of 100 Tgas, then {stop}; \
         account NEAR change: {} yocto; key now: {key:?}",
        after - before
    );
    assert!(sent < 200, "the allowance never ran out");
    Ok(())
}
