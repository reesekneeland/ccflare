import { describe, expect, it } from "bun:test";
import type { Account, AccountProvider, RequestMeta } from "@ccflare/types";
import { selectAccountsForRequest } from "./account-selector";
import type { ResolvedProxyContext } from "./proxy-types";

function createAccount(
	id: string,
	name: string,
	provider: AccountProvider,
): Account {
	return {
		id,
		name,
		provider,
		auth_method: "api_key",
		base_url: null,
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		weight: 1,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		ratelimit_5h_utilization: null,
		ratelimit_5h_reset: null,
		ratelimit_5h_status: null,
		ratelimit_7d_utilization: null,
		ratelimit_7d_reset: null,
		ratelimit_7d_status: null,
		overage_status: null,
	};
}

describe("selectAccountsForRequest", () => {
	it("filters accounts using the resolved provider name", () => {
		const seenProviders: string[][] = [];
		const meta: RequestMeta = {
			id: "request-1",
			method: "POST",
			path: "/v1/openai/responses",
			timestamp: Date.now(),
		};
		const ctx = {
			providerName: "openai",
			strategy: {
				select(accounts: Account[]) {
					seenProviders.push(accounts.map((account) => account.provider));
					return accounts;
				},
			},
			dbOps: {
				getAvailableAccountsByProvider(provider: AccountProvider) {
					return [
						createAccount("a1", "anthropic-account", "anthropic"),
						createAccount("o1", "openai-account", "openai"),
					].filter((account) => account.provider === provider);
				},
			},
		} as unknown as ResolvedProxyContext;

		const selected = selectAccountsForRequest(meta, ctx);

		expect(seenProviders).toEqual([["openai"]]);
		expect(selected.map((account) => account.name)).toEqual(["openai-account"]);
	});
});
