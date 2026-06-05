import { describe, expect, it } from "bun:test";
import type { Account, RequestMeta, StrategyStore } from "@ccflare/types";
import { SessionStrategy } from "./index";

const SESSION_MS = 5 * 60 * 60 * 1000;

function createAccount(
	id: string,
	name: string,
	overrides: Partial<Account> = {},
): Account {
	return {
		id,
		name,
		provider: "claude-code",
		auth_method: "oauth",
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
		...overrides,
	};
}

function createStore(): StrategyStore & { resets: [string, number][] } {
	const resets: [string, number][] = [];
	return {
		resets,
		resetAccountSession(accountId: string, timestamp: number) {
			resets.push([accountId, timestamp]);
		},
	};
}

const meta: RequestMeta = {
	id: "request-1",
	method: "POST",
	path: "/v1/claude-code/v1/messages",
	timestamp: Date.now(),
};

function makeStrategy(lastResort: string[] = []): SessionStrategy {
	const strategy = new SessionStrategy(SESSION_MS, lastResort);
	strategy.initialize(createStore());
	return strategy;
}

describe("SessionStrategy", () => {
	it("sticks to the account with the most recent active session", () => {
		const strategy = makeStrategy();
		const a = createAccount("a", "first");
		const b = createAccount("b", "second", {
			session_start: Date.now() - 1000,
		});

		const selected = strategy.select([a, b], meta);
		expect(selected.map((acc) => acc.name)).toEqual(["second", "first"]);
	});

	it("picks the first available account when no session is active", () => {
		const strategy = makeStrategy();
		const a = createAccount("a", "first");
		const b = createAccount("b", "second");

		const selected = strategy.select([a, b], meta);
		expect(selected[0].name).toBe("first");
	});

	it("orders last-resort accounts after preferred ones when starting fresh", () => {
		const strategy = makeStrategy(["reese"]);
		const lastResort = createAccount("a", "reese");
		const preferred = createAccount("b", "rek");

		const selected = strategy.select([lastResort, preferred], meta);
		expect(selected.map((acc) => acc.name)).toEqual(["rek", "reese"]);
	});

	it("uses a last-resort account when no preferred account is available", () => {
		const strategy = makeStrategy(["reese"]);
		const lastResort = createAccount("a", "reese");
		const limited = createAccount("b", "rek", {
			rate_limited_until: Date.now() + 60_000,
		});

		const selected = strategy.select([lastResort, limited], meta);
		expect(selected.map((acc) => acc.name)).toEqual(["reese"]);
	});

	it("sticks to a last-resort session while preferred accounts are limited", () => {
		const strategy = makeStrategy(["reese"]);
		const lastResort = createAccount("a", "reese", {
			session_start: Date.now() - 1000,
		});
		const limited = createAccount("b", "rek", {
			rate_limited_until: Date.now() + 60_000,
		});

		const selected = strategy.select([lastResort, limited], meta);
		expect(selected[0].name).toBe("reese");
	});

	it("preempts a last-resort session once a preferred account is available", () => {
		const store = createStore();
		const strategy = new SessionStrategy(SESSION_MS, ["reese"]);
		strategy.initialize(store);

		const lastResort = createAccount("a", "reese", {
			session_start: Date.now() - 1000,
		});
		const preferred = createAccount("b", "rek");

		const selected = strategy.select([lastResort, preferred], meta);
		expect(selected[0].name).toBe("rek");
		// A fresh session must be started on the preferred account so that
		// stickiness moves off the last-resort account on subsequent requests.
		expect(store.resets.map(([id]) => id)).toContain("b");
		expect(preferred.session_start).not.toBeNull();
	});

	it("preempts even when the preferred account has an older unexpired session", () => {
		const now = Date.now();
		const strategy = makeStrategy(["reese"]);
		const lastResort = createAccount("a", "reese", {
			session_start: now - 1000,
		});
		const preferred = createAccount("b", "rek", {
			// Older session, still within the window — previously rate-limited
			// mid-session, now recovered.
			session_start: now - 60_000,
		});

		const selected = strategy.select([lastResort, preferred], meta);
		expect(selected[0].name).toBe("rek");
		// Forced session restart: rek's session_start is now the most recent,
		// so the next select() sticks to rek without needing to preempt again.
		const next = strategy.select([lastResort, preferred], meta);
		expect(next[0].name).toBe("rek");
	});

	it("never preempts a preferred account's session", () => {
		const strategy = makeStrategy(["reese"]);
		const lastResort = createAccount("a", "reese");
		const preferred = createAccount("b", "rek", {
			session_start: Date.now() - 1000,
		});

		const selected = strategy.select([lastResort, preferred], meta);
		expect(selected[0].name).toBe("rek");
	});

	describe("burn-down ordering", () => {
		const future = Date.now() + 60 * 60 * 1000;

		it("picks the highest 5h utilization first (no last-resort configured)", () => {
			const strategy = makeStrategy(); // burn-down must apply with no last-resort
			const low = createAccount("a", "low", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});
			const high = createAccount("b", "high", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});

			const selected = strategy.select([low, high], meta);
			expect(selected.map((a) => a.name)).toEqual(["high", "low"]);
		});

		it("breaks utilization ties by soonest 7d reset", () => {
			const strategy = makeStrategy();
			const later = createAccount("a", "later", {
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() + 7 * 86_400_000,
			});
			const sooner = createAccount("b", "sooner", {
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() + 1 * 86_400_000,
			});

			const selected = strategy.select([later, sooner], meta);
			expect(selected.map((a) => a.name)).toEqual(["sooner", "later"]);
		});

		it("sorts a never-seen (null util) account last among preferred", () => {
			const strategy = makeStrategy();
			const unseen = createAccount("a", "unseen");
			const seen = createAccount("b", "seen", {
				ratelimit_5h_utilization: 0.1,
				ratelimit_5h_reset: future,
			});

			const selected = strategy.select([unseen, seen], meta);
			expect(selected.map((a) => a.name)).toEqual(["seen", "unseen"]);
		});

		it("treats a rolled-over (stale-reset) window as 0 util", () => {
			const strategy = makeStrategy();
			// 'stale' has high stored util but its 5h window already reset → effective 0,
			// so it should rank BELOW a seat genuinely at 0.3, and ABOVE a never-seen seat.
			const stale = createAccount("a", "stale", {
				ratelimit_5h_utilization: 0.95,
				ratelimit_5h_reset: Date.now() - 1000,
			});
			const active = createAccount("b", "active", {
				ratelimit_5h_utilization: 0.3,
				ratelimit_5h_reset: future,
			});
			const unseen = createAccount("c", "unseen");

			const selected = strategy.select([stale, unseen, active], meta);
			expect(selected.map((a) => a.name)).toEqual([
				"active",
				"stale",
				"unseen",
			]);
		});

		it("orders multiple last-resort accounts by burn-down among themselves", () => {
			const strategy = makeStrategy(["lr-low", "lr-high"]);
			const lrLow = createAccount("a", "lr-low", {
				ratelimit_5h_utilization: 0.1,
				ratelimit_5h_reset: future,
			});
			const lrHigh = createAccount("b", "lr-high", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});

			// No preferred accounts: the most-burned last-resort seat goes first.
			expect(strategy.select([lrLow, lrHigh], meta).map((a) => a.name)).toEqual(
				["lr-high", "lr-low"],
			);

			// Reversed input order (fresh state so no session stickiness applies):
			// ordering must be identical, not input-order dependent.
			const strategy2 = makeStrategy(["lr-low", "lr-high"]);
			const lrLow2 = createAccount("a", "lr-low", {
				ratelimit_5h_utilization: 0.1,
				ratelimit_5h_reset: future,
			});
			const lrHigh2 = createAccount("b", "lr-high", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});
			expect(
				strategy2.select([lrHigh2, lrLow2], meta).map((a) => a.name),
			).toEqual(["lr-high", "lr-low"]);
		});

		it("keeps last-resort last even when it has the highest utilization", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				ratelimit_5h_utilization: 0.99,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.1,
				ratelimit_5h_reset: future,
			});

			const selected = strategy.select([reese, rek], meta);
			expect(selected.map((a) => a.name)).toEqual(["rek", "reese"]);
		});

		it("is deterministic across calls", () => {
			const strategy = makeStrategy();
			const a = createAccount("a", "aaa", {
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
			});
			const b = createAccount("b", "bbb", {
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
			});
			const first = strategy.select([a, b], meta).map((x) => x.name);
			const second = strategy.select([b, a], meta).map((x) => x.name);
			expect(first).toEqual(second);
		});

		it("stickiness overrides burn-down ranking", () => {
			const strategy = makeStrategy();
			// 'sticky' has an active session but lower util; burn-down would prefer 'hot'.
			const sticky = createAccount("a", "sticky", {
				session_start: Date.now() - 1000,
				ratelimit_5h_utilization: 0.1,
				ratelimit_5h_reset: future,
			});
			const hot = createAccount("b", "hot", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});

			const selected = strategy.select([hot, sticky], meta);
			expect(selected[0].name).toBe("sticky");
		});

		it("a sticky account with null util still wins over a high-util preferred", () => {
			const strategy = makeStrategy();
			const sticky = createAccount("a", "sticky", {
				session_start: Date.now() - 1000,
			});
			const hot = createAccount("b", "hot", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});

			const selected = strategy.select([hot, sticky], meta);
			expect(selected[0].name).toBe("sticky");
		});
	});
});
