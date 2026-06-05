import {
	type Account,
	type AccountProvider,
	type AccountRateLimitInfo,
	type AccountSessionInfo,
	type AuthMethod,
	getAccountRateLimitInfo,
	getAccountSessionInfo,
	getAccountTokenStatus,
} from "@ccflare/types";

export interface AccountRateLimitStatusView {
	code: string;
	isLimited: boolean;
	until: string | null;
}

export interface AccountSessionInfoView {
	active: boolean;
	startedAt: string | null;
	requestCount: number;
}

export interface AccountDisplay {
	id: string;
	name: string;
	provider: AccountProvider;
	auth_method: AuthMethod;
	base_url: string | null;
	weightDisplay: string;
	created: Date;
	lastUsed: Date | null;
	requestCount: number;
	totalRequests: number;
	tokenStatus: "valid" | "expired";
	rateLimitStatus: string;
	sessionInfo: string;
	paused: boolean;
	weight?: number;
	rateLimit: AccountRateLimitInfo;
	session: AccountSessionInfo;
}

function toTimestamp(value: number | string | null | undefined): number | null {
	if (value === null || value === undefined) {
		return null;
	}

	if (typeof value === "number") {
		return value;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? null : timestamp;
}

export function formatAccountRateLimitStatus(
	rateLimit:
		| AccountRateLimitInfo
		| AccountRateLimitStatusView
		| {
				code: string;
				isLimited: boolean;
				until?: number | string | null;
		  },
	resetAt?: number | string | null,
	now: number = Date.now(),
): string {
	if (rateLimit.code === "paused") {
		return "Paused";
	}

	const untilTs = toTimestamp(rateLimit.until ?? null);
	if (rateLimit.isLimited && untilTs && untilTs > now) {
		return `Rate limited (${Math.ceil((untilTs - now) / 60000)}m)`;
	}

	if (rateLimit.code !== "ok") {
		const resetTs = toTimestamp(resetAt);
		if (resetTs && resetTs > now) {
			return `${rateLimit.code} (${Math.ceil((resetTs - now) / 60000)}m)`;
		}
		return rateLimit.code;
	}

	return "OK";
}

export function formatAccountSessionInfo(
	session:
		| AccountSessionInfo
		| AccountSessionInfoView
		| {
				active: boolean;
				startedAt?: number | string | null;
				requestCount: number;
		  },
	now: number = Date.now(),
): string {
	const startedAt = toTimestamp(session.startedAt ?? null);
	if (!session.active || startedAt === null) {
		return "-";
	}

	const sessionAgeMinutes = Math.max(0, Math.floor((now - startedAt) / 60000));
	return `${session.requestCount} reqs, ${sessionAgeMinutes}m ago`;
}

export function toAccountDisplay(
	account: Account,
	now: number = Date.now(),
): AccountDisplay {
	const rateLimit = getAccountRateLimitInfo(account, now);
	const session = getAccountSessionInfo(account);

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		auth_method: account.auth_method,
		base_url: account.base_url,
		weightDisplay: `${account.weight}x`,
		created: new Date(account.created_at),
		lastUsed: account.last_used ? new Date(account.last_used) : null,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		tokenStatus: getAccountTokenStatus(account, now),
		rateLimitStatus: formatAccountRateLimitStatus(
			rateLimit,
			rateLimit.resetAt,
			now,
		),
		sessionInfo: formatAccountSessionInfo(session, now),
		paused: account.paused,
		weight: account.weight,
		rateLimit,
		session,
	};
}
