//! Inti Spending Limits: a contract that runs on the user's own NEAR account.
//! It holds no funds of its own and has no custodian.
//!
//! Funds never leave the user's account except through `fund_agent`, which sends
//! the amount of one order to the user's agent on NEAR Intents, within per-order
//! and per-day limits counted on-chain.
//!
//! Who can do what:
//! - Inti holds a function-call key on this account restricted to `fund_agent`.
//!   Function-call keys cannot attach a deposit, so Inti can never call the
//!   owner methods, which require exactly 1 yoctoNEAR.
//! - The user signs with their full-access key: owner methods, plain token
//!   transfers (withdrawals need no method) and deleting Inti's key.
//! - Every mutating method requires the caller to be this account itself, so
//!   no third party can trigger anything.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;
/// Gas for the token's `ft_transfer_call` (includes intents.near `ft_on_transfer`
/// and the token's resolve step). To be confirmed with a real transfer.
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);

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

#[near(serializers = [borsh])]
struct DailyUsage {
    day: u64,
    spent: u128,
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
    usage: LookupMap<AccountId, DailyUsage>,
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
        }
    }

    /// Sends `amount` of `token` to the agent's NEAR Intents balance.
    /// Called by Inti's function-call key for each order.
    pub fn fund_agent(&mut self, token: AccountId, amount: U128) -> Promise {
        assert_self();
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        let limit = self
            .limits
            .get(&token)
            .cloned()
            .unwrap_or_else(|| env::panic_str("token not allowed"));
        require!(amount <= limit.per_order.0, "over the per-order limit");

        let today = current_day();
        let spent = self.spent_on(&token, today);
        let new_spent = spent
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("amount overflow"));
        require!(new_spent <= limit.per_day.0, "over the daily limit");
        // Reserve before the transfer so concurrent orders cannot pass the limit.
        self.usage.insert(token.clone(), DailyUsage { day: today, spent: new_spent });

        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER_CALL)
            .ft_transfer_call(self.intents.clone(), U128(amount), None, self.agent.to_string())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .on_fund_resolved(token, U128(amount), today),
            )
    }

    /// Releases the unused part of the reservation. If the result is unknown,
    /// the full amount stays counted: the limit can only err on the safe side.
    #[private]
    pub fn on_fund_resolved(
        &mut self,
        token: AccountId,
        amount: U128,
        day: u64,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> U128 {
        let used = match used {
            Ok(value) => value.0.min(amount.0),
            Err(_) => amount.0,
        };
        let unused = amount.0 - used;
        if unused > 0 {
            if let Some(usage) = self.usage.get_mut(&token) {
                if usage.day == day {
                    usage.spent = usage.spent.saturating_sub(unused);
                }
            }
        }
        U128(used)
    }

    // ---------- Owner methods (full-access key only: 1 yoctoNEAR) ----------

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        assert_owner();
        self.agent = agent;
    }

    #[payable]
    pub fn set_limit(&mut self, token: AccountId, per_order: U128, per_day: U128) {
        assert_owner();
        require!(per_order.0 > 0, "per_order must be positive");
        require!(per_order.0 <= per_day.0, "per_order must not exceed per_day");
        self.limits.insert(token, TokenLimit { per_order, per_day });
    }

    #[payable]
    pub fn remove_limit(&mut self, token: AccountId) {
        assert_owner();
        self.limits.remove(&token);
    }

    // ---------- Receiving tokens ----------

    /// Accepts every incoming `ft_transfer_call` (for example the agent sending
    /// results back), so tokens sent to this account are never refunded.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = (sender_id, amount, msg);
        PromiseOrValue::Value(U128(0))
    }

    // ---------- Views ----------

    pub fn get_config(&self) -> LimitsConfig {
        LimitsConfig { intents: self.intents.clone(), agent: self.agent.clone() }
    }

    pub fn get_limit(&self, token: AccountId) -> Option<TokenLimit> {
        self.limits.get(&token).cloned()
    }

    pub fn get_spent_today(&self, token: AccountId) -> U128 {
        U128(self.spent_on(&token, current_day()))
    }
}

impl SpendingLimits {
    fn spent_on(&self, token: &AccountId, day: u64) -> u128 {
        match self.usage.get(token) {
            Some(usage) if usage.day == day => usage.spent,
            _ => 0,
        }
    }
}

fn current_day() -> u64 {
    env::block_timestamp() / NANOS_PER_DAY
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
        let mut contract = SpendingLimits::new("intents.near".parse().unwrap(), "agent.near".parse().unwrap());
        context(user(), 1, 1);
        contract.set_limit(usdc(), U128(per_order), U128(per_day));
        context(user(), 0, 1);
        contract
    }

    #[test]
    #[should_panic(expected = "only this account can call this method")]
    fn init_by_others_fails() {
        context("attacker.near".parse().unwrap(), 0, 1);
        SpendingLimits::new("intents.near".parse().unwrap(), "attacker.near".parse().unwrap());
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
        assert_eq!(contract.get_spent_today(usdc()), U128(100));
    }

    #[test]
    fn unused_amount_is_released() {
        let mut contract = contract_with_limit(100, 100);
        let _ = contract.fund_agent(usdc(), U128(100));
        let used = contract.on_fund_resolved(usdc(), U128(100), 1, Ok(U128(40)));
        assert_eq!(used, U128(40));
        assert_eq!(contract.get_spent_today(usdc()), U128(40));
    }

    #[test]
    fn failed_transfer_result_stays_counted() {
        let mut contract = contract_with_limit(100, 100);
        let _ = contract.fund_agent(usdc(), U128(100));
        let used = contract.on_fund_resolved(usdc(), U128(100), 1, Err(PromiseError::Failed));
        assert_eq!(used, U128(100));
        assert_eq!(contract.get_spent_today(usdc()), U128(100));
    }

    #[test]
    #[should_panic(expected = "per_order must not exceed per_day")]
    fn invalid_limit_rejected() {
        contract_with_limit(200, 100);
    }
}
