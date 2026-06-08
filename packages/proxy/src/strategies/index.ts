import { isAccountAvailable, TIME_CONSTANTS } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	SelectionOrderEntry,
	SelectionStatus,
	StrategyStore,
} from "@ccflare/types";

/**
 * Comma-separated account names for seats that have pay-per-use "extra usage"
 * enabled (e.g. `reese`). These seats are balanced like any other account while
 * their own 5-hour quota has headroom, but once that window fills — every
 * further request bills overage — they become last-resort: used only when no
 * other account is available, and preempted back to a normal seat the moment one
 * frees up. They are also exempt from the 7-day exhaustion block (overage lets
 * them keep serving past the weekly cap).
 */
const EXTRA_USAGE_SEATS_ENV = "CCFLARE_LAST_RESORT_ACCOUNTS";

/**
 * Utilization fraction (0–1) at or above which a quota window is treated as
 * fully consumed. Set just below 1.0 so we react right at the cap even if the
 * provider ever reports slightly under 100%, and so the extra-usage seat flips
 * to last-resort *before* it starts billing overage rather than one request
 * after.
 */
const MAX_UTIL = 0.99;

export class SessionStrategy implements LoadBalancingStrategy {
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionStrategy");
	private extraUsageSeats: Set<string>;

	constructor(
		sessionDurationMs: number = TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		extraUsageSeats?: Iterable<string>,
	) {
		this.sessionDurationMs = sessionDurationMs;
		this.extraUsageSeats = new Set(
			extraUsageSeats ??
				(process.env[EXTRA_USAGE_SEATS_ENV] ?? "")
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
		);
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	/**
	 * Static identity: seats named in `CCFLARE_LAST_RESORT_ACCOUNTS`. These are
	 * the only accounts permitted to serve on pay-per-use overage. Identity is
	 * env-based, NOT derived from the `overage_status` header — that field is
	 * unreliable here (the usage endpoint reports `enabled` for every seat).
	 */
	private isExtraUsageSeat(account: Account): boolean {
		return this.extraUsageSeats.has(account.name);
	}

	/**
	 * Reset-aware "this quota window is fully consumed", used for the extra-usage
	 * seat's last-resort flip (`actsAsLastResort`). A window whose reset has already
	 * passed is stale (the fresh value just hasn't been observed yet) → not maxed; a
	 * never-seen window (null utilization) → not maxed. A known utilization with no
	 * reset timestamp is treated as the live window and judged on utilization alone:
	 * for the flip this is the conservative choice (it keeps a maxed extra-usage seat
	 * in last-resort position rather than ranking it first and billing overage). The
	 * exhaustion *block* uses a stricter check (`is7dExhausted`) so an unknown reset
	 * never hard-excludes an account.
	 */
	private isWindowMaxed(
		util: number | null,
		reset: number | null,
		now: number,
	): boolean {
		if (util == null) return false;
		if (reset != null && now >= reset) return false;
		return util >= MAX_UTIL;
	}

	/**
	 * A flat-rate seat whose 7-day quota is exhausted cannot serve until the
	 * window resets, so it drops out of selection entirely. The extra-usage seat
	 * is exempt — its overage lets it keep serving past the weekly cap.
	 *
	 * Blocking requires a known, unexpired reset: a null/unknown 7d reset must NOT
	 * hard-exclude an account (e.g. a freshly-added seat whose first usage poll
	 * carried a utilization but no reset timestamp), which would strand it out of
	 * selection indefinitely. A genuinely-maxed seat with an unknown reset is still
	 * caught by the provider's 429 → `rate_limited_until` path instead.
	 */
	private is7dExhausted(account: Account, now: number): boolean {
		if (this.isExtraUsageSeat(account)) return false;
		const util = account.ratelimit_7d_utilization;
		const reset = account.ratelimit_7d_reset;
		return util != null && reset != null && now < reset && util >= MAX_UTIL;
	}

	/**
	 * Whether an extra-usage seat is currently acting as a last resort: only once
	 * its own 5-hour window has filled, at which point every request bills overage.
	 * Below the threshold it is a normal balanced account; a non-extra-usage seat
	 * never acts as last resort.
	 */
	private actsAsLastResort(account: Account, now: number): boolean {
		return (
			this.isExtraUsageSeat(account) &&
			this.isWindowMaxed(
				account.ratelimit_5h_utilization,
				account.ratelimit_5h_reset,
				now,
			)
		);
	}

	/**
	 * Selectable for traffic: available (not paused / not rate-limited) AND not
	 * blocked by an exhausted 7-day quota. This is the single eligibility gate
	 * used for both continuing a session and (re)selecting one.
	 */
	private isSelectable(account: Account, now: number): boolean {
		return (
			isAccountAvailable(account, now) && !this.is7dExhausted(account, now)
		);
	}

	/**
	 * Effective 5-hour quota utilization for ranking. A window whose reset has
	 * already passed is stale (we just haven't observed the fresh value yet), so
	 * treat it as 0 (not burned). A never-seen account (null) returns -1 so it
	 * sorts after any account with an observed value — burn-down prefers seats
	 * with known burn before trying an unknown one.
	 */
	private effective5hUtil(account: Account, now: number): number {
		if (account.ratelimit_5h_utilization == null) return -1;
		if (
			account.ratelimit_5h_reset != null &&
			now >= account.ratelimit_5h_reset
		) {
			return 0;
		}
		return account.ratelimit_5h_utilization;
	}

	/**
	 * Burn-down order: most-utilized 5h seat first (finish one before opening the
	 * next), tie-broken by soonest 7-day reset, then name for determinism.
	 */
	private compareBurnDown(a: Account, b: Account, now: number): number {
		const ua = this.effective5hUtil(a, now);
		const ub = this.effective5hUtil(b, now);
		if (ua !== ub) return ub - ua;
		const ra = a.ratelimit_7d_reset ?? Number.POSITIVE_INFINITY;
		const rb = b.ratelimit_7d_reset ?? Number.POSITIVE_INFINITY;
		if (ra !== rb) return ra - rb;
		return a.name.localeCompare(b.name);
	}

	/**
	 * Order accounts for selection/failover: normally-balanced accounts in
	 * burn-down order, then accounts currently acting as last resort (extra-usage
	 * seats whose 5h window has filled — reached only when nothing else is
	 * available). Both buckets use the same burn-down comparator.
	 */
	private prioritize(accounts: Account[], now: number): Account[] {
		const preferred = accounts
			.filter((a) => !this.actsAsLastResort(a, now))
			.sort((x, y) => this.compareBurnDown(x, y, now));
		const lastResort = accounts
			.filter((a) => this.actsAsLastResort(a, now))
			.sort((x, y) => this.compareBurnDown(x, y, now));
		return [...preferred, ...lastResort];
	}

	private startNewSession(account: Account, now: number): void {
		if (!this.store) return;
		this.store.resetAccountSession(account.id, now);

		// Update the account object to reflect changes
		account.session_start = now;
		account.session_request_count = 0;
	}

	private resetSessionIfExpired(account: Account): void {
		const now = Date.now();

		if (
			!account.session_start ||
			now - account.session_start >= this.sessionDurationMs
		) {
			// Reset session
			if (this.store) {
				const wasExpired = account.session_start !== null;
				this.log.info(
					wasExpired
						? `Session expired for account ${account.name}, starting new session`
						: `Starting new session for account ${account.name}`,
				);
				this.startNewSession(account, now);
			}
		}
	}

	/**
	 * Find the most-recent in-window session holder and decide whether it keeps
	 * the session. `continues` is false when there is no active account, when the
	 * active account is no longer selectable (rate-limited / 7d-exhausted), or
	 * when it is an extra-usage seat acting as last resort that should be
	 * preempted because a normally-balanced account is available. Shared by
	 * `select()` and `previewSelectionOrder()` so the two can't diverge.
	 */
	private resolveActive(
		accounts: Account[],
		now: number,
	): { active: Account | null; continues: boolean } {
		let active: Account | null = null;
		let mostRecent = 0;
		for (const account of accounts) {
			if (
				account.session_start &&
				now - account.session_start < this.sessionDurationMs &&
				account.session_start > mostRecent
			) {
				active = account;
				mostRecent = account.session_start;
			}
		}
		if (!active || !this.isSelectable(active, now)) {
			return { active, continues: false };
		}
		const preempt =
			this.actsAsLastResort(active, now) &&
			accounts.some(
				(a) =>
					a.id !== active.id &&
					!this.actsAsLastResort(a, now) &&
					this.isSelectable(a, now),
			);
		return { active, continues: !preempt };
	}

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();
		const { active, continues } = this.resolveActive(accounts, now);

		// A selectable, non-preempted active account keeps the session exclusively.
		if (active && continues) {
			// Reset session if expired (shouldn't happen but just in case)
			this.resetSessionIfExpired(active);
			this.log.info(
				`Continuing session for account ${active.name} (${active.session_request_count} requests in session)`,
			);
			const others = this.prioritize(
				accounts.filter((a) => a.id !== active.id && this.isSelectable(a, now)),
				now,
			);
			return [active, ...others];
		}

		// Active account is leaving the session. Distinguish the two cases that
		// must force a fresh session on the replacement (so stickiness moves off
		// the account we left): a preempted extra-usage seat in overage, or a
		// flat-rate account whose 7-day quota filled mid-session.
		let preempt = false;
		let droppedAccount: Account | null = null;
		if (active && this.isSelectable(active, now)) {
			// Selectable but not continuing → it was preempted (an extra-usage seat
			// acting as last resort while a normally-balanced account is available).
			preempt = true;
			this.log.info(
				`Preempting overage session on account ${active.name}: a normally-balanced account is available`,
			);
		} else if (
			active &&
			isAccountAvailable(active, now) &&
			this.is7dExhausted(active, now)
		) {
			droppedAccount = active;
		}

		// Filter selectable accounts, preferred first.
		const available = this.prioritize(
			accounts.filter((a) => this.isSelectable(a, now)),
			now,
		);

		if (available.length === 0) return [];

		// Pick the first available account and start a new session with it
		const chosenAccount = available[0];
		if (preempt || droppedAccount) {
			// Force a fresh session even if this account has an unexpired one;
			// its session_start must become the most recent so stickiness moves
			// off the account we just left on subsequent requests. The 7d-drop is
			// logged here — only once a replacement is actually chosen — so it can't
			// re-fire every request when no replacement is available.
			if (droppedAccount) {
				this.log.info(
					`Dropping 7d-exhausted session on account ${droppedAccount.name}: switching to ${chosenAccount.name} until the 7-day window resets`,
				);
			}
			this.log.info(`Starting new session for account ${chosenAccount.name}`);
			this.startNewSession(chosenAccount, now);
		} else {
			this.resetSessionIfExpired(chosenAccount);
		}

		// Return chosen account first, then others as fallback
		const others = available.filter((a) => a.id !== chosenAccount.id);
		return [chosenAccount, ...others];
	}

	/**
	 * Read-only twin of `select()` for display: classify every account with its
	 * activation rank and the reason for its place, without mutating session
	 * state. The ordered (rank-bearing) entries are exactly the candidate list
	 * `select()` would return; excluded accounts get a null rank and a reason.
	 */
	previewSelectionOrder(
		accounts: Account[],
		now: number = Date.now(),
	): SelectionOrderEntry[] {
		const { active, continues } = this.resolveActive(accounts, now);
		const hasActive = !!(active && continues);
		const selectable = accounts.filter((a) => this.isSelectable(a, now));

		const ordered =
			active && continues
				? [
						active,
						...this.prioritize(
							selectable.filter((a) => a.id !== active.id),
							now,
						),
					]
				: this.prioritize(selectable, now);

		const entries: SelectionOrderEntry[] = ordered.map((account, index) => ({
			id: account.id,
			rank: index + 1,
			status: this.classifySelectable(account, index, hasActive, now),
		}));

		const orderedIds = new Set(ordered.map((a) => a.id));
		for (const account of accounts) {
			if (orderedIds.has(account.id)) continue;
			entries.push({
				id: account.id,
				rank: null,
				status: this.excludedStatus(account, now),
			});
		}
		return entries;
	}

	/** Status for an account that is in the activation order. */
	private classifySelectable(
		account: Account,
		index: number,
		hasActive: boolean,
		now: number,
	): SelectionStatus {
		// The continuing session leads, whatever kind of seat it is.
		if (index === 0 && hasActive) return "active";
		// An extra-usage seat at its cap only ever serves as a last resort.
		if (this.actsAsLastResort(account, now)) return "last-resort";
		// "next" = the first non-active selectable seat.
		if (index === (hasActive ? 1 : 0)) return "next";
		return "candidate";
	}

	/** Status for an account excluded from the activation order. */
	private excludedStatus(account: Account, now: number): SelectionStatus {
		if (account.paused) return "paused";
		if (!isAccountAvailable(account, now)) return "rate-limited";
		if (this.is7dExhausted(account, now)) return "blocked-7d";
		// Defensive: a non-selectable account always matches one of the above.
		return "candidate";
	}
}
