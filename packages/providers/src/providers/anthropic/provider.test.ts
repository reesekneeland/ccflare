import { describe, expect, it } from "bun:test";
import {
	createApiKeyAccount,
	expectBuildUrlCases,
	expectNoOAuthSupport,
	expectRemovedHeaders,
	expectUnifiedRateLimit,
} from "../../test-helpers";
import { AnthropicProvider } from "./provider";

describe("AnthropicProvider", () => {
	const provider = new AnthropicProvider();

	it("builds upstream URLs from the stripped Anthropic path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/v1/messages",
				expected: "https://api.anthropic.com/v1/messages",
			},
			{
				upstreamPath: "/v1/models",
				query: "?foo=bar&baz=qux",
				expected: "https://api.anthropic.com/v1/models?foo=bar&baz=qux",
			},
			{
				upstreamPath: "/v1/messages",
				account: createApiKeyAccount("anthropic", {
					base_url: "https://anthropic.internal/",
				}),
				expected: "https://anthropic.internal/v1/messages",
			},
		]);
	});

	it("injects x-api-key for API key accounts", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"accept-encoding": "gzip",
				"content-encoding": "gzip",
			}),
			createApiKeyAccount("anthropic"),
		);

		expect(headers.get("x-api-key")).toBe("sk-ant-test");
		expect(headers.get("authorization")).toBeNull();
		expectRemovedHeaders(headers, [
			"host",
			"accept-encoding",
			"content-encoding",
		]);
	});

	it("ignores OAuth access tokens and does not expose OAuth helpers", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
			}),
			createApiKeyAccount("anthropic", {
				auth_method: "oauth",
				api_key: null,
				access_token: "oauth-access-token",
				refresh_token: "oauth-refresh-token",
				expires_at: Date.now() + 60_000,
			}),
		);

		expect(headers.get("authorization")).toBeNull();
		expectRemovedHeaders(headers, ["x-api-key", "host"]);
		expectNoOAuthSupport(provider);
	});

	it("parses Anthropic unified rate limit headers", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-remaining": "17",
			},
		});

		expectUnifiedRateLimit(provider, response, {
			isRateLimited: false,
			resetTime: resetSeconds * 1000,
			statusHeader: "allowed",
			remaining: 17,
		});
	});

	it("parses 5h/7d window utilization, resets, and overage status", () => {
		const fiveHourResetSeconds = Math.floor((Date.now() + 3_600_000) / 1000);
		const sevenDayResetSeconds = Math.floor((Date.now() + 86_400_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed_warning",
				"anthropic-ratelimit-unified-reset": String(sevenDayResetSeconds),
				"anthropic-ratelimit-unified-5h-utilization": "0.18",
				"anthropic-ratelimit-unified-5h-reset": String(fiveHourResetSeconds),
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-7d-utilization": "0.85",
				"anthropic-ratelimit-unified-7d-reset": String(sevenDayResetSeconds),
				"anthropic-ratelimit-unified-7d-status": "allowed_warning",
				"anthropic-ratelimit-unified-overage-status": "rejected",
			},
		});

		expect(provider.parseRateLimit(response)).toMatchObject({
			isRateLimited: false,
			statusHeader: "allowed_warning",
			fiveHourUtilization: 0.18,
			fiveHourReset: fiveHourResetSeconds * 1000,
			fiveHourStatus: "allowed",
			sevenDayUtilization: 0.85,
			sevenDayReset: sevenDayResetSeconds * 1000,
			sevenDayStatus: "allowed_warning",
			overageStatus: "rejected",
		});
	});

	it("leaves window fields undefined when only the rollup is present", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-reset": String(resetSeconds),
			},
		});

		const info = provider.parseRateLimit(response);
		expect(info.fiveHourUtilization).toBeUndefined();
		expect(info.sevenDayReset).toBeUndefined();
		expect(info.overageStatus).toBeUndefined();
	});

	it("429 fallback marks rate-limited and emits no window fields", () => {
		const response = new Response("{}", {
			status: 429,
			headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000)) },
		});

		const info = provider.parseRateLimit(response);
		expect(info.isRateLimited).toBe(true);
		expect(info.fiveHourUtilization).toBeUndefined();
		expect(info.sevenDayUtilization).toBeUndefined();
		expect(info.fiveHourStatus).toBeUndefined();
		expect(info.overageStatus).toBeUndefined();
	});
});
