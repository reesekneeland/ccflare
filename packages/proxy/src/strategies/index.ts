import { isAccountAvailable, TIME_CONSTANTS } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@ccflare/types";

/**
 * Comma-separated account names that should only serve traffic when no other
 * account is available (e.g. seats with pay-per-use extra usage enabled).
 * Sessions on these accounts are preempted as soon as a preferred account
 * becomes available again.
 */
const LAST_RESORT_ENV = "CCFLARE_LAST_RESORT_ACCOUNTS";

export class SessionStrategy implements LoadBalancingStrategy {
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionStrategy");
	private lastResortNames: Set<string>;

	constructor(
		sessionDurationMs: number = TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		lastResortNames?: Iterable<string>,
	) {
		this.sessionDurationMs = sessionDurationMs;
		this.lastResortNames = new Set(
			lastResortNames ??
				(process.env[LAST_RESORT_ENV] ?? "")
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean),
		);
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	private isLastResort(account: Account): boolean {
		return this.lastResortNames.has(account.name);
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
	 * Order accounts for selection/failover: preferred accounts in burn-down
	 * order, then last-resort accounts (only reached when nothing else is
	 * available). The burn-down sort applies whether or not last-resort accounts
	 * are configured.
	 */
	private prioritize(accounts: Account[]): Account[] {
		const now = Date.now();
		const preferred = accounts
			.filter((a) => !this.isLastResort(a))
			.sort((x, y) => this.compareBurnDown(x, y, now));
		const lastResort = accounts.filter((a) => this.isLastResort(a));
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

		// If we have an active account and it's available, use it exclusively —
		// unless it's a last-resort account and a preferred account has become
		// available, in which case the session is preempted off it so we stop
		// burning the last-resort account's quota.
		let preempt = false;
		if (activeAccount && isAccountAvailable(activeAccount, now)) {
			preempt =
				this.isLastResort(activeAccount) &&
				accounts.some(
					(a) =>
						a.id !== activeAccount.id &&
						!this.isLastResort(a) &&
						isAccountAvailable(a, now),
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
						(a) => a.id !== activeAccount.id && isAccountAvailable(a, now),
					),
				);
				return [activeAccount, ...others];
			}
			this.log.info(
				`Preempting last-resort session on account ${activeAccount.name}: a preferred account is available`,
			);
		}

		// No active session, active account is rate limited, or a last-resort
		// session was preempted. Filter available accounts, preferred first.
		const available = this.prioritize(
			accounts.filter((a) => isAccountAvailable(a, now)),
		);

		if (available.length === 0) return [];

		// Pick the first available account and start a new session with it
		const chosenAccount = available[0];
		if (preempt) {
			// Force a fresh session even if this account has an unexpired one;
			// its session_start must become the most recent so stickiness moves
			// off the last-resort account on subsequent requests.
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
