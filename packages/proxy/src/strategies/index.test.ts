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
});
