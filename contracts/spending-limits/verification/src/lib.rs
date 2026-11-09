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

    /// Any usage record the contract can hold: what it counts never exceeds the daily limit.
    fn any_reachable_usage(limit: Limit) -> Option<Usage> {
        if kani::any() {
            let usage = Usage {
                day: kani::any(),
                spent: kani::any(),
            };
            kani::assume(usage.spent <= limit.per_day);
            Some(usage)
        } else {
            None
        }
    }

    /// An accepted order is never above the per-order limit, never takes the day above the
    /// daily limit, is counted on the day of its block, and the arithmetic never overflows.
    #[kani::proof]
    fn an_accepted_order_stays_within_both_limits() {
        let limit = any_limit();
        let usage = any_reachable_usage(limit);
        let amount: u128 = kani::any();
        let today: u64 = kani::any();
        if let Ok(next) = fund_on_day(Some(limit), usage, amount, today) {
            assert!(amount > 0);
            assert!(amount <= limit.per_order);
            assert!(next.spent <= limit.per_day);
            assert!(next.day == today);
            assert!(next.spent == spent_on(usage, today) + amount);
        }
    }

    /// Without a limit for the token no order passes.
    #[kani::proof]
    fn no_order_passes_for_a_token_without_a_limit() {
        let usage: Option<Usage> = if kani::any() {
            Some(Usage {
                day: kani::any(),
                spent: kani::any(),
            })
        } else {
            None
        };
        assert!(fund_on_day(None, usage, kani::any(), kani::any()).is_err());
    }

    /// A callback never panics, never reports more than the order, never frees more than
    /// the order, never adds to the count, and never touches another day's record.
    #[kani::proof]
    fn a_callback_frees_at_most_its_own_order() {
        let usage: Option<Usage> = if kani::any() {
            Some(Usage {
                day: kani::any(),
                spent: kani::any(),
            })
        } else {
            None
        };
        let amount: u128 = kani::any();
        let day: u64 = kani::any();
        let result: Option<u128> = if kani::any() { Some(kani::any()) } else { None };
        let (used, after) = resolve(usage, amount, day, result);
        assert!(used <= amount);
        match (usage, after) {
            (None, None) => {}
            (Some(before), Some(after)) => {
                assert!(after.day == before.day);
                assert!(after.spent <= before.spent);
                assert!(before.spent - after.spent <= amount - used);
                if before.day != day {
                    assert!(after.spent == before.spent);
                }
            }
            _ => panic!("a callback never creates or deletes the record"),
        }
        if result.is_none() {
            assert!(used == amount);
            assert!(after == usage);
        }
    }

    /// Promise of the product: within one calendar day the agent never receives more than
    /// the daily limit, whatever the order of orders and callbacks and whatever each token
    /// call did (an honest token reports what it moved; a failed call moved all or nothing).
    ///
    /// Proven by induction over any number of steps on one token and one day. The invariant:
    /// what the agent already received plus the orders still in flight is covered by the
    /// day's count, and the count is within the daily limit. It holds at the start of a day
    /// (everything is zero), and this proof shows that one more order or one more callback,
    /// from any state where it holds, keeps it. Callbacks of other days never change this
    /// day's record (`a_callback_frees_at_most_its_own_order`).
    #[kani::proof]
    fn the_agent_never_receives_more_than_the_daily_limit_in_one_day() {
        let limit = any_limit();
        let day: u64 = kani::any();
        let counted: u128 = kani::any();
        let received: u128 = kani::any();
        let in_flight: u128 = kani::any();
        kani::assume(counted <= limit.per_day);
        kani::assume(received <= counted && in_flight <= counted - received);
        let usage = Some(Usage {
            day,
            spent: counted,
        });
        if kani::any() {
            // One more order.
            let amount: u128 = kani::any();
            if let Ok(next) = fund_on_day(Some(limit), usage, amount, day) {
                assert!(next.day == day);
                assert!(next.spent <= limit.per_day);
                assert!(received + in_flight + amount <= next.spent);
            }
        } else {
            // The callback of one order still in flight.
            let amount: u128 = kani::any();
            kani::assume(amount <= in_flight);
            let (moved, result) = if kani::any() {
                let moved_all: bool = kani::any();
                (if moved_all { amount } else { 0 }, None)
            } else {
                let moved: u128 = kani::any();
                kani::assume(moved <= amount);
                (moved, Some(moved))
            };
            let (_, next) = resolve(usage, amount, day, result);
            let next = next.expect("the day's record stays");
            assert!(next.day == day);
            assert!(next.spent <= limit.per_day);
            assert!(received + moved + (in_flight - amount) <= next.spent);
        }
    }
}
