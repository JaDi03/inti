//! The limit arithmetic of Spending Limits as plain functions, with no NEAR host calls.
//! Each function follows the matching lines of `src/lib.rs` step by step, so properties
//! proven here hold for the contract as long as the two stay the same; a property test
//! in `tests/invariants.rs` runs both side by side on random call sequences to check that.

pub const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limit {
    pub per_order: u128,
    pub per_day: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Usage {
    pub day: u64,
    pub spent: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    ZeroAmount,
    TokenNotAllowed,
    OverPerOrder,
    AmountOverflow,
    OverDaily,
}

/// `current_day()`: the UTC calendar day of a block timestamp.
pub fn day_of(timestamp: u64) -> u64 {
    timestamp / NANOS_PER_DAY
}

/// `spent_on()`: what is counted for `day`; another day's record counts as zero.
pub fn spent_on(usage: Option<Usage>, day: u64) -> u128 {
    match usage {
        Some(usage) if usage.day == day => usage.spent,
        _ => 0,
    }
}

/// `set_limit()` checks.
pub fn check_limit(per_order: u128, per_day: u128) -> Option<Limit> {
    if per_order == 0 || per_order > per_day {
        return None;
    }
    Some(Limit { per_order, per_day })
}

/// `fund_agent()` checks and reservation: the usage record to store when the order passes.
/// The contract reads the day once (`current_day()`) and uses it for both the count and the
/// stored record, as `fund_on_day` does with `today`.
pub fn fund(
    limit: Option<Limit>,
    usage: Option<Usage>,
    amount: u128,
    timestamp: u64,
) -> Result<Usage, Refusal> {
    fund_on_day(limit, usage, amount, day_of(timestamp))
}

/// `fund_agent()` for an order whose block falls on calendar day `today`.
pub fn fund_on_day(
    limit: Option<Limit>,
    usage: Option<Usage>,
    amount: u128,
    today: u64,
) -> Result<Usage, Refusal> {
    if amount == 0 {
        return Err(Refusal::ZeroAmount);
    }
    let limit = limit.ok_or(Refusal::TokenNotAllowed)?;
    if amount > limit.per_order {
        return Err(Refusal::OverPerOrder);
    }
    let spent = spent_on(usage, today);
    let new_spent = spent.checked_add(amount).ok_or(Refusal::AmountOverflow)?;
    if new_spent > limit.per_day {
        return Err(Refusal::OverDaily);
    }
    Ok(Usage {
        day: today,
        spent: new_spent,
    })
}

/// `on_fund_resolved()`: `result` is the token's reported used amount, or None when the
/// transfer promise failed. Returns the used amount and the usage record afterwards.
pub fn resolve(
    usage: Option<Usage>,
    amount: u128,
    day: u64,
    result: Option<u128>,
) -> (u128, Option<Usage>) {
    let used = match result {
        Some(value) => value.min(amount),
        None => amount,
    };
    let unused = amount - used;
    let mut usage = usage;
    if unused > 0 {
        if let Some(record) = usage.as_mut() {
            if record.day == day {
                record.spent = record.spent.saturating_sub(unused);
            }
        }
    }
    (used, usage)
}
