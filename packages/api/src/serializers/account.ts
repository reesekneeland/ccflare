import {
	type Account,
	getAccountRateLimitInfo,
	getAccountSessionInfo,
	getAccountTokenStatus,
} from "@ccflare/types";
import type { AccountResponse } from "../types";

export function serializeAccount(
	account: Account,
	now: number = Date.now(),
): AccountResponse {
	const rateLimit = getAccountRateLimitInfo(account, now);
	const session = getAccountSessionInfo(account);

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		auth_method: account.auth_method,
		base_url: account.base_url,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		lastUsed: account.last_used
			? new Date(account.last_used).toISOString()
			: null,
		created: new Date(account.created_at).toISOString(),
		weight: account.weight,
		paused: account.paused,
		tokenStatus: getAccountTokenStatus(account, now),
		tokenExpiresAt: account.expires_at
			? new Date(account.expires_at).toISOString()
			: null,
		rateLimitStatus: {
			code: rateLimit.code,
			isLimited: rateLimit.isLimited,
			until: rateLimit.until ? new Date(rateLimit.until).toISOString() : null,
		},
		rateLimitReset: rateLimit.resetAt
			? new Date(rateLimit.resetAt).toISOString()
			: null,
		rateLimitRemaining: rateLimit.remaining,
		utilization5h: account.ratelimit_5h_utilization,
		reset5h: account.ratelimit_5h_reset
			? new Date(account.ratelimit_5h_reset).toISOString()
			: null,
		status5h: account.ratelimit_5h_status,
		utilization7d: account.ratelimit_7d_utilization,
		reset7d: account.ratelimit_7d_reset
			? new Date(account.ratelimit_7d_reset).toISOString()
			: null,
		status7d: account.ratelimit_7d_status,
		overageStatus: account.overage_status,
		sessionInfo: {
			active: session.active,
			startedAt: session.startedAt
				? new Date(session.startedAt).toISOString()
				: null,
			requestCount: session.requestCount,
		},
	};
}
