//! Inti Spending Limits: a contract that runs on the user's own NEAR account.
//! It holds no funds of its own and has no custodian.
//!
//! Inti's key can move funds only through `fund_agent`, which sends one order to
//! the user's agent on NEAR Intents, within a per-order limit and a daily limit
//! counted on-chain over the last 24 hours. The user's full-access key keeps full
//! control of the account and its funds.
//!
//! Who can do what:
//! - Inti holds a function-call key on this account restricted to `fund_agent`.
//!   Function-call keys cannot attach a deposit, so Inti can never call the
//!   owner methods, which require exactly 1 yoctoNEAR.
//! - The user signs with their full-access key: owner methods, plain token
//!   transfers (withdrawals need no method) and deleting Inti's key.
//! - Every method that sends funds or changes the limits or the agent requires
//!   the caller to be this account itself, so no third party can trigger them.
//!   `ft_on_transfer` can be called by any token and changes nothing.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

/// An order counts against the daily limit for 24 hours after it is sent, so no
/// 24-hour period ever lets more than the daily limit through.
const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;
/// At most this many orders per token count at once; it also bounds the stored list.
const MAX_ORDERS_PER_DAY: usize = 24;
/// Gas for the token's `ft_transfer_call` (includes intents.near `ft_on_transfer`
/// and the token's resolve step). To be confirmed with a real transfer.
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);
/// Least gas an order must attach: the token call, the callback and this method's
/// own work. An order with less is refused before it is counted.
const GAS_FOR_ORDER: Gas = Gas::from_tgas(80);
/// NEP-297 event standard name and version of this contract's logs.
const EVENT_STANDARD: &str = "inti_spending_limits";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Limits,
    Usage,
}

/// Limits for one NEP-141 token, in the token's atomic units.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenLimit {
    pub per_order: U128,
    pub per_day: U128,
}

/// One order sent to the agent. `amount` is what still counts: the full order until the
/// token reports a smaller used amount.
#[near(serializers = [borsh])]
#[derive(Clone)]
struct Order {
    id: u64,
    at: u64,
    amount: u128,
}

/// An order that counts against the daily limit; it stops counting 24 hours after `at`.
#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct OrderView {
    /// Block time of the order, in nanoseconds since the Unix epoch.
    pub at: U64,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct LimitsConfig {
    pub intents: AccountId,
    pub agent: AccountId,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SpendingLimits {
    /// NEAR Intents verifier contract (intents.near on mainnet). Fixed at init.
    intents: AccountId,
    /// The user's agent account on NEAR Intents (Agent API `near_account_id`).
    agent: AccountId,
    limits: LookupMap<AccountId, TokenLimit>,
    /// Orders of the last 24 hours per token, oldest first.
    usage: LookupMap<AccountId, Vec<Order>>,
    next_order_id: u64,
}

#[near]
impl SpendingLimits {
    /// Only the account itself can initialize, so nobody can set their own agent first.
    #[init]
    pub fn new(intents: AccountId, agent: AccountId) -> Self {
        assert_self();
        Self {
            intents,
            agent,
            limits: LookupMap::new(StorageKey::Limits),
            usage: LookupMap::new(StorageKey::Usage),
            next_order_id: 0,
        }
    }

    /// Sends `amount` of `token` to the agent's NEAR Intents balance.
    /// Called by Inti's function-call key for each order.
    pub fn fund_agent(&mut self, token: AccountId, amount: U128) -> Promise {
        assert_self();
        require!(
            env::prepaid_gas() >= GAS_FOR_ORDER,
            "not enough gas for the order"
        );
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        let limit = self
            .limits
            .get(&token)
            .cloned()
            .unwrap_or_else(|| env::panic_str("token not allowed"));
        require!(amount <= limit.per_order.0, "over the per-order limit");

        let now = env::block_timestamp();
        let mut orders = self.orders_in_window(&token, now);
        require!(
            orders.len() < MAX_ORDERS_PER_DAY,
            "over the daily number of orders"
        );
        let new_spent = total(&orders)
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("amount overflow"));
        require!(new_spent <= limit.per_day.0, "over the daily limit");
        // Reserve before the transfer so concurrent orders cannot pass the limit.
        let order_id = self.next_order_id;
        self.next_order_id = order_id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("order id overflow"));
        orders.push(Order {
            id: order_id,
            at: now,
            amount,
        });
        self.usage.insert(token.clone(), orders);
        emit(
            "order_sent",
            json!({
                "token": token,
                "amount": U128(amount),
                "order_id": order_id,
                "agent": self.agent,
            }),
        );

        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER_CALL)
            .ft_transfer_call(
                self.intents.clone(),
                U128(amount),
                None,
                self.agent.to_string(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .on_fund_resolved(token, U128(amount), order_id),
            )
    }

    /// Releases the unused part of the order's reservation. If the result is unknown,
    /// longer than 64 bytes (a used amount takes at most 41) or not a number, the full
    /// amount stays counted. A released part relies
    /// on the amount the token reports, so the owner approves each token with
    /// `set_limit` and only those tokens are called.
    #[private]
    pub fn on_fund_resolved(
        &mut self,
        token: AccountId,
        amount: U128,
        order_id: u64,
        #[callback_result(max_bytes = 64)] used: Result<U128, PromiseError>,
    ) -> U128 {
        let reported = used.is_ok();
        let used = match used {
            Ok(value) => value.0.min(amount.0),
            Err(_) => amount.0,
        };
        // `used` never exceeds `amount`, so nothing is lost by saturating.
        let unused = amount.0.saturating_sub(used);
        if unused > 0 {
            if let Some(orders) = self.usage.get_mut(&token) {
                // An order older than 24 hours is already gone and no longer counts.
                if let Some(order) = orders.iter_mut().find(|order| order.id == order_id) {
                    order.amount = order.amount.saturating_sub(unused);
                }
            }
        }
        emit(
            "order_resolved",
            json!({
                "token": token,
                "order_id": order_id,
                "amount": amount,
                "used": U128(used),
                "reported": reported,
            }),
        );
        U128(used)
    }

    // ---------- Owner methods (full-access key only: 1 yoctoNEAR) ----------

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        assert_owner();
        emit("agent_set", json!({ "agent": agent }));
        self.agent = agent;
    }

    #[payable]
    pub fn set_limit(&mut self, token: AccountId, per_order: U128, per_day: U128) {
        assert_owner();
        require!(per_order.0 > 0, "per_order must be positive");
        require!(
            per_order.0 <= per_day.0,
            "per_order must not exceed per_day"
        );
        emit(
            "limit_set",
            json!({ "token": token, "per_order": per_order, "per_day": per_day }),
        );
        self.limits.insert(token, TokenLimit { per_order, per_day });
    }

    #[payable]
    pub fn remove_limit(&mut self, token: AccountId) {
        assert_owner();
        emit("limit_removed", json!({ "token": token }));
        self.limits.remove(&token);
    }

    // ---------- Receiving tokens ----------

    /// Accepts every incoming `ft_transfer_call` (for example the agent sending
    /// results back), so tokens sent to this account are never refunded.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = (sender_id, amount, msg);
        PromiseOrValue::Value(U128(0))
    }

    // ---------- Views ----------

    pub fn get_config(&self) -> LimitsConfig {
        LimitsConfig {
            intents: self.intents.clone(),
            agent: self.agent.clone(),
        }
    }

    pub fn get_limit(&self, token: AccountId) -> Option<TokenLimit> {
        self.limits.get(&token).cloned()
    }

    /// What counts against the daily limit now: the orders of the last 24 hours.
    pub fn get_spent_last_24h(&self, token: AccountId) -> U128 {
        U128(total(
            &self.orders_in_window(&token, env::block_timestamp()),
        ))
    }

    /// The orders that count against the daily limit now, oldest first.
    pub fn get_orders_last_24h(&self, token: AccountId) -> Vec<OrderView> {
        self.orders_in_window(&token, env::block_timestamp())
            .into_iter()
            .map(|order| OrderView {
                at: U64(order.at),
                amount: U128(order.amount),
            })
            .collect()
    }
}

impl SpendingLimits {
    /// The token's orders sent less than 24 hours before `now`.
    fn orders_in_window(&self, token: &AccountId, now: u64) -> Vec<Order> {
        self.usage
            .get(token)
            .map(|orders| {
                orders
                    .iter()
                    .filter(|order| now.saturating_sub(order.at) < NANOS_PER_DAY)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Logs one NEP-297 event, so wallets and indexers can follow every order and
/// every change the owner makes.
fn emit(event: &str, data: Value) {
    let event = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{event}"));
}

fn total(orders: &[Order]) -> u128 {
    orders.iter().fold(0u128, |sum, order| {
        sum.checked_add(order.amount)
            .unwrap_or_else(|| env::panic_str("amount overflow"))
    })
}

fn assert_self() {
    require!(
        env::predecessor_account_id() == env::current_account_id(),
        "only this account can call this method"
    );
}

fn assert_owner() {
    assert_one_yocto();
    assert_self();
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn user() -> AccountId {
        "user.near".parse().unwrap()
    }
    fn usdc() -> AccountId {
        "usdc.near".parse().unwrap()
    }

    fn context(predecessor: AccountId, deposit_yocto: u128, day: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(user())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .block_timestamp(day * NANOS_PER_DAY + 1);
        testing_env!(builder.build());
    }

    fn contract_with_limit(per_order: u128, per_day: u128) -> SpendingLimits {
        context(user(), 0, 1);
        let mut contract = SpendingLimits::new(
            "intents.near".parse().unwrap(),
            "agent.near".parse().unwrap(),
        );
        context(user(), 1, 1);
        contract.set_limit(usdc(), U128(per_order), U128(per_day));
        context(user(), 0, 1);
        contract
    }

    #[test]
    #[should_panic(expected = "only this account can call this method")]
    fn init_by_others_fails() {
        context("attacker.near".parse().unwrap(), 0, 1);
        SpendingLimits::new(
            "intents.near".parse().unwrap(),
            "attacker.near".parse().unwrap(),
        );
    }

    #[test]
    #[should_panic(expected = "only this account can call this method")]
    fn fund_agent_by_others_fails() {
        let mut contract = contract_with_limit(100, 300);
        context("attacker.near".parse().unwrap(), 0, 1);
        let _ = contract.fund_agent(usdc(), U128(10));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn owner_method_without_deposit_fails() {
        let mut contract = contract_with_limit(100, 300);
        context(user(), 0, 1);
        contract.set_agent("other.near".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "token not allowed")]
    fn unknown_token_fails() {
        let mut contract = contract_with_limit(100, 300);
        let _ = contract.fund_agent("other-token.near".parse().unwrap(), U128(10));
    }

    #[test]
    #[should_panic(expected = "over the per-order limit")]
    fn per_order_limit() {
        let mut contract = contract_with_limit(100, 300);
        let _ = contract.fund_agent(usdc(), U128(101));
    }

    #[test]
    #[should_panic(expected = "over the daily limit")]
    fn daily_limit() {
        let mut contract = contract_with_limit(100, 250);
        let _ = contract.fund_agent(usdc(), U128(100));
        let _ = contract.fund_agent(usdc(), U128(100));
        let _ = contract.fund_agent(usdc(), U128(100));
    }

    #[test]
    fn daily_limit_resets_next_day() {
        let mut contract = contract_with_limit(100, 100);
        let _ = contract.fund_agent(usdc(), U128(100));
        context(user(), 0, 2);
        let _ = contract.fund_agent(usdc(), U128(100));
        assert_eq!(contract.get_spent_last_24h(usdc()), U128(100));
    }

    #[test]
    fn unused_amount_is_released() {
        let mut contract = contract_with_limit(100, 100);
        let _ = contract.fund_agent(usdc(), U128(100));
        let used = contract.on_fund_resolved(usdc(), U128(100), 0, Ok(U128(40)));
        assert_eq!(used, U128(40));
        assert_eq!(contract.get_spent_last_24h(usdc()), U128(40));
    }

    #[test]
    fn failed_transfer_result_stays_counted() {
        let mut contract = contract_with_limit(100, 100);
        let _ = contract.fund_agent(usdc(), U128(100));
        let used = contract.on_fund_resolved(usdc(), U128(100), 0, Err(PromiseError::Failed));
        assert_eq!(used, U128(100));
        assert_eq!(contract.get_spent_last_24h(usdc()), U128(100));
    }

    #[test]
    #[should_panic(expected = "per_order must not exceed per_day")]
    fn invalid_limit_rejected() {
        contract_with_limit(200, 100);
    }

    fn context_at(timestamp: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(user())
            .predecessor_account_id(user())
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    #[test]
    #[should_panic(expected = "over the daily limit")]
    fn daily_limit_holds_across_utc_midnight() {
        let mut contract = contract_with_limit(100, 100);
        context_at(2 * NANOS_PER_DAY - 1);
        let _ = contract.fund_agent(usdc(), U128(100));
        context_at(2 * NANOS_PER_DAY + 1);
        let _ = contract.fund_agent(usdc(), U128(1));
    }

    #[test]
    fn an_order_stops_counting_exactly_24_hours_later() {
        let mut contract = contract_with_limit(100, 100);
        let start = 5 * NANOS_PER_DAY + 7;
        context_at(start);
        let _ = contract.fund_agent(usdc(), U128(100));
        context_at(start + NANOS_PER_DAY - 1);
        assert_eq!(contract.get_spent_last_24h(usdc()), U128(100));
        context_at(start + NANOS_PER_DAY);
        assert_eq!(contract.get_spent_last_24h(usdc()), U128(0));
        let _ = contract.fund_agent(usdc(), U128(100));
        assert_eq!(
            contract.get_orders_last_24h(usdc()),
            vec![OrderView {
                at: U64(start + NANOS_PER_DAY),
                amount: U128(100)
            }]
        );
    }

    #[test]
    #[should_panic(expected = "over the daily number of orders")]
    fn daily_number_of_orders() {
        let mut contract = contract_with_limit(1, 1_000);
        for order in 0..=MAX_ORDERS_PER_DAY as u64 {
            context_at(NANOS_PER_DAY + 1 + order);
            let _ = contract.fund_agent(usdc(), U128(1));
        }
    }

    #[test]
    fn a_callback_frees_only_its_own_order() {
        let mut contract = contract_with_limit(100, 300);
        let _ = contract.fund_agent(usdc(), U128(100));
        let _ = contract.fund_agent(usdc(), U128(100));
        let used = contract.on_fund_resolved(usdc(), U128(100), 1, Ok(U128(30)));
        assert_eq!(used, U128(30));
        assert_eq!(contract.get_spent_last_24h(usdc()), U128(130));
        let amounts: Vec<U128> = contract
            .get_orders_last_24h(usdc())
            .into_iter()
            .map(|order| order.amount)
            .collect();
        assert_eq!(amounts, vec![U128(100), U128(30)]);
    }
}
