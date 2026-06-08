import type { Account } from "./account";
import type { RequestMeta } from "./api";
import type { StrategyStore } from "./strategy";

/**
 * Why an account holds its place in the selection/failover order, for display.
 * - `active`: holds the current sticky session; serving now.
 * - `next`: highest-ranked non-active selectable seat — activated next.
 * - `candidate`: selectable, further down the burn-down order.
 * - `last-resort`: extra-usage seat acting as last resort (5h maxed) — overage only.
 * - `blocked-7d`: 7-day quota exhausted; excluded until that window resets.
 * - `rate-limited`: excluded until its rate limit clears.
 * - `paused`: operator-paused.
 */
export type SelectionStatus =
	| "active"
	| "next"
	| "candidate"
	| "last-resort"
	| "blocked-7d"
	| "rate-limited"
	| "paused";

/** One account's place in the strategy's activation order (display only). */
export interface SelectionOrderEntry {
	id: string;
	/** 1-based position in the activation order; null when the account is excluded. */
	rank: number | null;
	status: SelectionStatus;
}

// Load balancing strategy interface
export interface LoadBalancingStrategy {
	/**
	 * Return a filtered & ordered list of candidate accounts.
	 * Accounts that are rate-limited should be filtered out.
	 * The first account in the list should be tried first.
	 */
	select(accounts: Account[], meta: RequestMeta): Account[];

	/**
	 * Optional initialization method to inject dependencies
	 * Used for strategies that need access to a StrategyStore
	 */
	initialize?(store: StrategyStore): void;

	/**
	 * Read-only preview of `select()`'s ordering for display: every account
	 * classified with its activation rank and the reason for its place. Mutates
	 * nothing (no session writes). Optional — callers must guard for its presence.
	 */
	previewSelectionOrder?(
		accounts: Account[],
		now?: number,
	): SelectionOrderEntry[];
}
