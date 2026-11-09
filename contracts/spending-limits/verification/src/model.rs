//! The limit arithmetic of Spending Limits as plain functions, with no NEAR host calls.
//! Each function follows the matching lines of `src/lib.rs` step by step, so properties
//! proven here hold for the contract as long as the two stay the same; a property test
//! in `tests/invariants.rs` runs both side by side on random call sequences to check that.

pub const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;
pub const MAX_ORDERS_PER_DAY: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limit {
    pub per_order: u128,
    pub per_day: u128,
}

/// `Order`: one order and what still counts of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub struct Order {
    pub id: u64,
    pub at: u64,
    pub amount: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    ZeroAmount,
    TokenNotAllowed,
    OverPerOrder,
    TooManyOrders,
    AmountOverflow,
    OverDaily,
}

/// `orders_in_window()`: the orders sent less than 24 hours before `now`.
pub fn in_window(orders: &[Order], now: u64) -> Vec<Order> {
    orders
        .iter()
        .filter(|order| now.saturating_sub(order.at) < NANOS_PER_DAY)
        .copied()
        .collect()
}

/// `total()`: None where the contract panics with "amount overflow".
pub fn total(orders: &[Order]) -> Option<u128> {
    orders
        .iter()
        .try_fold(0u128, |sum, order| sum.checked_add(order.amount))
}

/// `get_spent_last_24h()`.
pub fn spent(orders: &[Order], now: u64) -> Option<u128> {
    total(&in_window(orders, now))
}

/// `set_limit()` checks.
pub fn check_limit(per_order: u128, per_day: u128) -> Option<Limit> {
    if per_order == 0 || per_order > per_day {
        return None;
    }
    Some(Limit { per_order, per_day })
}

/// `fund_agent()` checks and reservation (the gas check comes first in the contract and is
/// not modelled): the order list to store when the order passes, with the new order `id`
/// sent at `now` added last.
pub fn fund(
    limit: Option<Limit>,
    orders: &[Order],
    amount: u128,
    now: u64,
    id: u64,
) -> Result<Vec<Order>, Refusal> {
    if amount == 0 {
        return Err(Refusal::ZeroAmount);
    }
    let limit = limit.ok_or(Refusal::TokenNotAllowed)?;
    if amount > limit.per_order {
        return Err(Refusal::OverPerOrder);
    }
    let mut next = in_window(orders, now);
    if next.len() >= MAX_ORDERS_PER_DAY {
        return Err(Refusal::TooManyOrders);
    }
    let new_spent = total(&next)
        .and_then(|spent| spent.checked_add(amount))
        .ok_or(Refusal::AmountOverflow)?;
    if new_spent > limit.per_day {
        return Err(Refusal::OverDaily);
    }
    next.push(Order {
        id,
        at: now,
        amount,
    });
    Ok(next)
}

/// `on_fund_resolved()`: `result` is the token's reported used amount, or None when the
/// transfer promise failed or its result could not be read. Returns the used amount and
/// the order list afterwards.
pub fn resolve(
    orders: &[Order],
    amount: u128,
    id: u64,
    result: Option<u128>,
) -> (u128, Vec<Order>) {
    let used = match result {
        Some(value) => value.min(amount),
        None => amount,
    };
    let unused = amount - used;
    let mut orders = orders.to_vec();
    if unused > 0 {
        if let Some(order) = orders.iter_mut().find(|order| order.id == id) {
            order.amount = order.amount.saturating_sub(unused);
        }
    }
    (used, orders)
}
