import { afterEach, describe, expect, it } from "bun:test";
import {
	createJsonFetchMock,
	createOAuthAccount,
	expectBuildUrlCases,
	expectRemovedHeaders,
	expectUnifiedRateLimit,
	originalFetch,
} from "../../test-helpers";
import { ClaudeCodeProvider } from "./provider";

describe("ClaudeCodeProvider", () => {
	const provider = new ClaudeCodeProvider();

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("builds upstream URLs from the stripped Claude Code path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/v1/messages",
				expected: "https://api.anthropic.com/v1/messages",
			},
			{
				upstreamPath: "/v1/models",
				query: "?foo=bar",
				expected: "https://api.anthropic.com/v1/models?foo=bar",
			},
			{
				upstreamPath: "/v1/messages",
				account: createOAuthAccount("claude-code", {
					base_url: "https://anthropic.internal/",
				}),
				expected: "https://anthropic.internal/v1/messages",
			},
		]);
	});

	it("injects Authorization: Bearer and never x-api-key", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"x-api-key": "client-supplied-key",
				"accept-encoding": "gzip",
				"content-encoding": "gzip",
			}),
			createOAuthAccount("claude-code"),
		);

		expect(headers.get("authorization")).toBe("Bearer claude-access-token");
		expectRemovedHeaders(headers, [
			"x-api-key",
			"host",
			"accept-encoding",
			"content-encoding",
		]);
	});

	it("refreshes OAuth tokens via platform.claude.com", async () => {
		let requestUrl = "";
		let requestBody = "";

		globalThis.fetch = createJsonFetchMock(
			{
				access_token: "fresh-claude-access-token",
				refresh_token: "fresh-claude-refresh-token",
				expires_in: 1800,
			},
			async (request) => {
				requestUrl = request.url;
				requestBody = await request.text();
			},
		);

		const refreshed = await provider.refreshToken(
			createOAuthAccount("claude-code"),
			"test-client-id",
		);

		expect(requestUrl).toBe("https://platform.claude.com/v1/oauth/token");
		expect(requestBody).toContain('"grant_type":"refresh_token"');
		expect(requestBody).toContain('"refresh_token":"claude-refresh-token"');
		expect(requestBody).toContain('"client_id":"test-client-id"');
		expect(refreshed).toEqual({
			accessToken: "fresh-claude-access-token",
			refreshToken: "fresh-claude-refresh-token",
			expiresAt: expect.any(Number),
		});
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

	it("fetchUsage normalizes the zero-cost usage endpoint (0-100 → 0-1, derived status)", async () => {
		const fiveReset = "2026-06-05T22:50:00.000+00:00";
		const sevenReset = "2026-06-07T18:00:00.000+00:00";
		let requestUrl = "";
		let betaHeader = "";
		globalThis.fetch = createJsonFetchMock(
			{
				five_hour: { utilization: 21.0, resets_at: fiveReset },
				seven_day: { utilization: 90.0, resets_at: sevenReset },
				// is_enabled wins even when a stale disabled_reason is present.
				extra_usage: {
					is_enabled: true,
					disabled_reason: "suspended_due_to_nonpayment",
				},
			},
			(request) => {
				requestUrl = request.url;
				betaHeader = request.headers.get("anthropic-beta") ?? "";
			},
		);

		const usage = await provider.fetchUsage("token-xyz");

		expect(requestUrl).toBe("https://api.anthropic.com/api/oauth/usage");
		expect(betaHeader).toBe("oauth-2025-04-20");
		expect(usage).toEqual({
			fiveHourUtilization: 0.21,
			fiveHourReset: Date.parse(fiveReset),
			fiveHourStatus: "allowed", // 0.21 < 0.8
			sevenDayUtilization: 0.9,
			sevenDayReset: Date.parse(sevenReset),
			sevenDayStatus: "allowed_warning", // 0.9 >= 0.8
			overageStatus: "enabled",
		});
	});

	it("fetchUsage leaves overageStatus undefined when extra_usage is absent", async () => {
		globalThis.fetch = createJsonFetchMock({
			five_hour: { utilization: 10.0, resets_at: "2026-06-05T22:50:00.000Z" },
			seven_day: { utilization: 20.0, resets_at: "2026-06-07T18:00:00.000Z" },
		});

		const usage = await provider.fetchUsage("token-xyz");

		expect(usage?.fiveHourUtilization).toBe(0.1);
		// Unknown overage state must stay undefined (column untouched), not "disabled".
		expect(usage?.overageStatus).toBeUndefined();
	});

	it("fetchUsage returns null on a non-OK response", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as unknown as typeof fetch;
		expect(await provider.fetchUsage("bad-token")).toBeNull();
	});
});
