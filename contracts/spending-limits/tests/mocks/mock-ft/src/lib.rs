//! A NEP-141 token built on near-contract-standards that can also act as a token receiver.
//! The same code is deployed twice in the sandbox tests: once as the token Spending Limits
//! sends, and once as the NEAR Intents stand-in that receives it. A mode chosen by the test
//! makes either side misbehave the way a real token or receiver can.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
}

/// The last incoming transfer this contract accepted as a receiver.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Received {
    pub token: AccountId,
    pub sender_id: AccountId,
    pub amount: U128,
    pub msg: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    token: FungibleToken,
    /// As a token: "standard", "panic" (refuses every transfer call), "under_report" (moves
    /// the tokens but reports none used) or "garbage" (returns a value that is not an amount).
    token_mode: String,
    /// As a receiver: "accept" (keeps everything), "refund" (returns everything) or "panic".
    receiver_mode: String,
    last_received: Option<Received>,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut token = FungibleToken::new(StorageKey::Token);
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        Self {
            token,
            token_mode: "standard".to_string(),
            receiver_mode: "accept".to_string(),
            last_received: None,
        }
    }

    pub fn set_modes(&mut self, token_mode: String, receiver_mode: String) {
        self.token_mode = token_mode;
        self.receiver_mode = receiver_mode;
    }

    /// Registers an account without a storage deposit (test convenience).
    pub fn register(&mut self, account_id: AccountId) {
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
    }

    pub fn last_received(&self) -> Option<Received> {
        self.last_received.clone()
    }

    pub fn not_an_amount(&self) -> String {
        "not an amount".to_string()
    }
}

#[near]
impl FungibleTokenCore for MockFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        match self.token_mode.as_str() {
            "panic" => env::panic_str("mock token refuses the transfer"),
            "under_report" => {
                self.token.ft_transfer(receiver_id, amount, memo);
                PromiseOrValue::Value(U128(0))
            }
            "garbage" => {
                PromiseOrValue::Promise(Self::ext(env::current_account_id()).not_an_amount())
            }
            _ => self.token.ft_transfer_call(receiver_id, amount, memo, msg),
        }
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl FungibleTokenReceiver for MockFt {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        match self.receiver_mode.as_str() {
            "refund" => PromiseOrValue::Value(amount),
            "panic" => env::panic_str("mock receiver fails"),
            _ => {
                self.last_received = Some(Received {
                    token: env::predecessor_account_id(),
                    sender_id,
                    amount,
                    msg,
                });
                PromiseOrValue::Value(U128(0))
            }
        }
    }
}
