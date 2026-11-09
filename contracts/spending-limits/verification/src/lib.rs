//! Formal proofs (Kani) of the Spending Limits limit arithmetic. Run with `cargo kani`.

pub mod model;

#[cfg(kani)]
mod proofs {
    use crate::model::*;

    fn any_limit() -> Limit {
        let per_order: u128 = kani::any();
        let per_day: u128 = kani::any();
        kani::assume(per_order > 0 && per_order <= per_day);
        Limit { per_order, per_day }
    }

    /// With one earlier order (any id, time at or before now, any amount), an accepted
    /// order is positive, at most per_order, and the earlier order (if still inside the
    /// last 24 hours) plus the new one stay at most per_day.
    #[kani::proof]
    #[kani::unwind(3)]
    #[kani::solver(cadical)]
    fn an_accepted_order_stays_within_both_limits() {
        let limit = any_limit();
        let now: u64 = kani::any();
        let earlier = any_earlier_order(now);
        let amount: u128 = kani::any();
        if let Ok(next) = fund(Some(limit), &[earlier], amount, now, 7) {
            assert!(amount > 0 && amount <= limit.per_order);
            let counts = now - earlier.at < NANOS_PER_DAY;
            let before = if counts { earlier.amount } else { 0 };
            assert!(before
                .checked_add(amount)
                .is_some_and(|sum| sum <= limit.per_day));
            assert!(next.len() == if counts { 2 } else { 1 });
        }
    }

    /// Two orders sent less than 24 hours apart, from an empty account, with the first one
    /// still counting in full (in flight, failed or fully used), together stay at most
    /// per_day; a callback can only lower the first
    /// (`a_callback_keeps_counting_what_the_agent_received`).
    #[kani::proof]
    #[kani::unwind(3)]
    #[kani::solver(cadical)]
    fn two_orders_within_24_hours_never_move_more_than_the_daily_limit() {
        let limit = any_limit();
        let t1: u64 = kani::any();
        let gap: u64 = kani::any();
        kani::assume(gap < NANOS_PER_DAY);
        kani::assume(t1.checked_add(gap).is_some());
        let t2 = t1 + gap;
        let a1: u128 = kani::any();
        let a2: u128 = kani::any();
        let first = Order {
            id: 0,
            at: t1,
            amount: a1,
        };
        kani::assume(a1 > 0 && a1 <= limit.per_order);
        if fund(Some(limit), &[first], a2, t2, 1).is_ok() {
            assert!(a1.checked_add(a2).is_some_and(|sum| sum <= limit.per_day));
        }
    }

    /// Any earlier order, sent at or before `now`. Each order is filtered and updated on
    /// its own, so the proofs use one earlier order; the property tests in
    /// `tests/invariants.rs` run lists of many orders on the contract.
    fn any_earlier_order(now: u64) -> Order {
        let order: Order = kani::any();
        kani::assume(order.at <= now);
        order
    }

    /// Without a limit for the token no order passes.
    #[kani::proof]
    #[kani::unwind(3)]
    fn no_order_passes_for_a_token_without_a_limit() {
        let now: u64 = kani::any();
        let earlier = [any_earlier_order(now)];
        let orders: &[Order] = if kani::any() { &earlier } else { &[] };
        assert!(fund(None, orders, kani::any(), now, kani::any()).is_err());
    }

    /// A callback never reports more than the order, never raises what any order counts,
    /// changes only the order with its own id and by at most the unused part, and with an
    /// unreadable result changes nothing.
    #[kani::proof]
    #[kani::unwind(3)]
    fn a_callback_frees_at_most_its_own_order() {
        let orders = [any_earlier_order(u64::MAX)];
        let amount: u128 = kani::any();
        let id: u64 = kani::any();
        let result: Option<u128> = if kani::any() { Some(kani::any()) } else { None };
        let (used, after) = resolve(&orders, amount, id, result);
        assert!(used <= amount);
        assert!(after.len() == orders.len());
        for (before, after) in orders.iter().zip(after.iter()) {
            assert!(after.id == before.id && after.at == before.at);
            assert!(after.amount <= before.amount);
            assert!(before.amount - after.amount <= amount - used);
            if before.id != id {
                assert!(after.amount == before.amount);
            }
        }
        if result.is_none() {
            assert!(used == amount);
            assert!(after == orders);
        }
        // `find` updates the first order with the id; ids are unique, so only that order.
    }

    /// What an order still counts never drops below what the agent received from it: an
    /// honest token reports what it moved, and a failed call moved all or nothing.
    #[kani::proof]
    #[kani::unwind(3)]
    fn a_callback_keeps_counting_what_the_agent_received() {
        let order: Order = kani::any();
        let (moved, result) = if kani::any() {
            let moved_all: bool = kani::any();
            (if moved_all { order.amount } else { 0 }, None)
        } else {
            let moved: u128 = kani::any();
            kani::assume(moved <= order.amount);
            (moved, Some(moved))
        };
        let (_, after) = resolve(&[order], order.amount, order.id, result);
        assert!(after[0].amount >= moved);
    }

    /// As time passes no order joins the last 24 hours: an order that counts at a later
    /// time already counted at any earlier time after it was sent. `in_window` keeps or
    /// drops each order on its own, so a later window holds only orders of the earlier one
    /// and never counts more.
    #[kani::proof]
    #[kani::unwind(3)]
    fn time_passing_never_adds_to_what_counts() {
        let order: Order = kani::any();
        let now: u64 = kani::any();
        let later: u64 = kani::any();
        kani::assume(order.at <= now && now <= later);
        if !in_window(&[order], later).is_empty() {
            assert!(in_window(&[order], now) == [order]);
        }
    }

    // Promise of the product, from the proofs above: in any 24 hours the agent never
    // receives more than the daily limit. Take any 24-hour period ending at time s and the
    // last accepted order at or before s, at time t. When it was accepted, the orders of the
    // 24 hours before t, itself included, counted at most the daily limit
    // (`an_accepted_order_stays_within_both_limits`). Between t and s no order was accepted,
    // callbacks only lowered what orders count (`a_callback_frees_at_most_its_own_order`),
    // and the period ending at s holds only orders of the period ending at t
    // (`time_passing_never_adds_to_what_counts`). Each order counts at least what the agent
    // received from it (`a_callback_keeps_counting_what_the_agent_received`), and orders
    // still in flight count in full. A refused order changes nothing: the call reverts.
}
