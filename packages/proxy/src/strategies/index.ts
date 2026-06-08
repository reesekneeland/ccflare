import { isAccountAvailable, TIME_CONSTANTS } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
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
const LAST_RESORT_ENV = "CCFLARE_LAST_RESORT_ACCOUNTS";

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
				(process.env[LAST_RESORT_ENV] ?? "")
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
	 * Reset-aware "this quota window is fully consumed". A window whose reset has
	 * already passed is stale (the fresh value just hasn't been observed yet), so
	 * it is treated as not maxed. A never-seen window (null utilization) is likewise
	 * not maxed — absence of data is not evidence of exhaustion. A known utilization
	 * with no reset timestamp is judged on utilization alone (treated as the live
	 * window), matching `effective5hUtil`; the next poll's utilization refreshes this
	 * even if the reset stays absent, so a stale-high value does not persist once the
	 * real window rolls over.
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
	 */
	private is7dExhausted(account: Account, now: number): boolean {
		return (
			!this.isExtraUsageSeat(account) &&
			this.isWindowMaxed(
				account.ratelimit_7d_utilization,
				account.ratelimit_7d_reset,
				now,
			)
		);
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

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();

		// Find account with active session (most recent session_start within window)
		let activeAccount: Account | null = null;
		let mostRecentSessionStart = 0;

		for (const account of accounts) {
			if (
				account.session_start &&
				now - account.session_start < this.sessionDurationMs &&
				account.session_start > mostRecentSessionStart
			) {
				activeAccount = account;
				mostRecentSessionStart = account.session_start;
			}
		}

		// If we have an active account and it's selectable, use it exclusively —
		// unless it's currently acting as a last resort (an extra-usage seat whose
		// 5h window has filled) and a normally-balanced account has become
		// available, in which case the session is preempted off it so we stop
		// burning overage.
		let preempt = false;
		if (activeAccount && this.isSelectable(activeAccount, now)) {
			preempt =
				this.actsAsLastResort(activeAccount, now) &&
				accounts.some(
					(a) =>
						a.id !== activeAccount.id &&
						!this.actsAsLastResort(a, now) &&
						this.isSelectable(a, now),
				);
			if (!preempt) {
				// Reset session if expired (shouldn't happen but just in case)
				this.resetSessionIfExpired(activeAccount);
				this.log.info(
					`Continuing session for account ${activeAccount.name} (${activeAccount.session_request_count} requests in session)`,
				);
				// Return active account first, then others as fallback
				const others = this.prioritize(
					accounts.filter(
						(a) => a.id !== activeAccount.id && this.isSelectable(a, now),
					),
					now,
				);
				return [activeAccount, ...others];
			}
			this.log.info(
				`Preempting overage session on account ${activeAccount.name}: a normally-balanced account is available`,
			);
		} else if (activeAccount && this.is7dExhausted(activeAccount, now)) {
			// The active account's 7-day quota filled mid-session, so it is no
			// longer selectable and traffic falls over to another account. Logged
			// (like the preempt path) so this otherwise-silent switch is diagnosable.
			this.log.info(
				`Dropping 7d-exhausted session on account ${activeAccount.name}: waiting for the 7-day window to reset`,
			);
		}

		// No active session, active account is unselectable, or an overage
		// session was preempted. Filter selectable accounts, preferred first.
		const available = this.prioritize(
			accounts.filter((a) => this.isSelectable(a, now)),
			now,
		);

		if (available.length === 0) return [];

		// Pick the first available account and start a new session with it
		const chosenAccount = available[0];
		if (preempt) {
			// Force a fresh session even if this account has an unexpired one;
			// its session_start must become the most recent so stickiness moves
			// off the extra-usage seat on subsequent requests.
			this.log.info(`Starting new session for account ${chosenAccount.name}`);
			this.startNewSession(chosenAccount, now);
		} else {
			this.resetSessionIfExpired(chosenAccount);
		}

		// Return chosen account first, then others as fallback
		const others = available.filter((a) => a.id !== chosenAccount.id);
		return [chosenAccount, ...others];
	}
}
