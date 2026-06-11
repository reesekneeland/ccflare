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

function makeStrategy(extraUsageSeats: string[] = []): SessionStrategy {
	const strategy = new SessionStrategy(SESSION_MS, extraUsageSeats);
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

	// An extra-usage seat acts as last resort only once its own 5h window is full;
	// these tests pin reese at the cap so it plays that role.
	const MAXED_5H = {
		ratelimit_5h_utilization: 1,
		ratelimit_5h_reset: Date.now() + 60 * 60 * 1000,
	};

	it("orders an exhausted extra-usage seat after preferred ones when starting fresh", () => {
		const strategy = makeStrategy(["reese"]);
		const reese = createAccount("a", "reese", { ...MAXED_5H });
		const preferred = createAccount("b", "rek");

		const selected = strategy.select([reese, preferred], meta);
		expect(selected.map((acc) => acc.name)).toEqual(["rek", "reese"]);
	});

	it("uses an exhausted extra-usage seat when no preferred account is available", () => {
		const strategy = makeStrategy(["reese"]);
		const reese = createAccount("a", "reese", { ...MAXED_5H });
		const limited = createAccount("b", "rek", {
			rate_limited_until: Date.now() + 60_000,
		});

		const selected = strategy.select([reese, limited], meta);
		expect(selected.map((acc) => acc.name)).toEqual(["reese"]);
	});

	it("sticks to an exhausted extra-usage session while preferred accounts are limited", () => {
		const strategy = makeStrategy(["reese"]);
		const reese = createAccount("a", "reese", {
			...MAXED_5H,
			session_start: Date.now() - 1000,
		});
		const limited = createAccount("b", "rek", {
			rate_limited_until: Date.now() + 60_000,
		});

		const selected = strategy.select([reese, limited], meta);
		expect(selected[0].name).toBe("reese");
	});

	it("preempts an exhausted extra-usage session once a preferred account is available", () => {
		const store = createStore();
		const strategy = new SessionStrategy(SESSION_MS, ["reese"]);
		strategy.initialize(store);

		const reese = createAccount("a", "reese", {
			...MAXED_5H,
			session_start: Date.now() - 1000,
		});
		const preferred = createAccount("b", "rek");

		const selected = strategy.select([reese, preferred], meta);
		expect(selected[0].name).toBe("rek");
		// A fresh session must be started on the preferred account so that
		// stickiness moves off the extra-usage seat on subsequent requests.
		expect(store.resets.map(([id]) => id)).toContain("b");
		expect(preferred.session_start).not.toBeNull();
	});

	it("preempts even when the preferred account has an older unexpired session", () => {
		const now = Date.now();
		const strategy = makeStrategy(["reese"]);
		const reese = createAccount("a", "reese", {
			...MAXED_5H,
			session_start: now - 1000,
		});
		const preferred = createAccount("b", "rek", {
			// Older session, still within the window — previously rate-limited
			// mid-session, now recovered.
			session_start: now - 60_000,
		});

		const selected = strategy.select([reese, preferred], meta);
		expect(selected[0].name).toBe("rek");
		// Forced session restart: rek's session_start is now the most recent,
		// so the next select() sticks to rek without needing to preempt again.
		const next = strategy.select([reese, preferred], meta);
		expect(next[0].name).toBe("rek");
	});

	it("never preempts a preferred account's session", () => {
		const strategy = makeStrategy(["reese"]);
		const reese = createAccount("a", "reese");
		const preferred = createAccount("b", "rek", {
			session_start: Date.now() - 1000,
		});

		const selected = strategy.select([reese, preferred], meta);
		expect(selected[0].name).toBe("rek");
	});

	describe("burn-down ordering", () => {
		const future = Date.now() + 60 * 60 * 1000;

		it("picks the highest 5h utilization first (no extra-usage seats configured)", () => {
			const strategy = makeStrategy(); // burn-down must apply with no extra-usage seats configured
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

		it("orders multiple exhausted extra-usage seats by burn-down among themselves", () => {
			// Both seats are at/over the cap, so both act as last resort; the
			// most-burned one still goes first within that trailing bucket.
			const strategy = makeStrategy(["lr-low", "lr-high"]);
			const lrLow = createAccount("a", "lr-low", {
				ratelimit_5h_utilization: 0.99,
				ratelimit_5h_reset: future,
			});
			const lrHigh = createAccount("b", "lr-high", {
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
			});

			// No preferred accounts: the most-burned extra-usage seat goes first.
			expect(strategy.select([lrLow, lrHigh], meta).map((a) => a.name)).toEqual(
				["lr-high", "lr-low"],
			);

			// Reversed input order (fresh state so no session stickiness applies):
			// ordering must be identical, not input-order dependent.
			const strategy2 = makeStrategy(["lr-low", "lr-high"]);
			const lrLow2 = createAccount("a", "lr-low", {
				ratelimit_5h_utilization: 0.99,
				ratelimit_5h_reset: future,
			});
			const lrHigh2 = createAccount("b", "lr-high", {
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
			});
			expect(
				strategy2.select([lrHigh2, lrLow2], meta).map((a) => a.name),
			).toEqual(["lr-high", "lr-low"]);
		});

		it("keeps an exhausted extra-usage seat last even when it has the highest utilization", () => {
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

		it("prioritizes an account inside an active 7d window over a fully-fresh one", () => {
			const strategy = makeStrategy();
			// 'fresh' has more 5h burn, but its 7d window has rolled over — serving
			// it would start a brand-new 7-day clock, so it goes to the back.
			const fresh = createAccount("a", "fresh", {
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() - 1000,
			});
			const inWindow = createAccount("b", "in-window", {
				ratelimit_5h_utilization: 0,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() + 3 * 86_400_000,
			});

			const selected = strategy.select([fresh, inWindow], meta);
			expect(selected.map((a) => a.name)).toEqual(["in-window", "fresh"]);
		});

		it("sorts a never-seen 7d window (null reset) with the fully-fresh group", () => {
			const strategy = makeStrategy();
			const inWindow = createAccount("a", "in-window", {
				ratelimit_7d_reset: Date.now() + 3 * 86_400_000,
			});
			const expired = createAccount("b", "expired", {
				ratelimit_5h_utilization: 0,
				ratelimit_5h_reset: Date.now() - 1000,
				ratelimit_7d_reset: Date.now() - 1000,
			});
			const unseen = createAccount("c", "unseen");

			// in-window leads; among the windowless, rolled-over (effective 5h util
			// 0) still beats never-seen (-1).
			const selected = strategy.select([unseen, expired, inWindow], meta);
			expect(selected.map((a) => a.name)).toEqual([
				"in-window",
				"expired",
				"unseen",
			]);
		});

		it("orders accounts with active 7d windows by 5h util, then soonest 7d reset", () => {
			const strategy = makeStrategy();
			const hot = createAccount("a", "hot", {
				ratelimit_5h_utilization: 0.7,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() + 6 * 86_400_000,
			});
			const endsSoon = createAccount("b", "ends-soon", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() + 1 * 86_400_000,
			});
			const endsLater = createAccount("c", "ends-later", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() + 4 * 86_400_000,
			});
			const fresh = createAccount("d", "fresh", {
				ratelimit_7d_reset: Date.now() - 1000,
			});

			const selected = strategy.select([fresh, endsLater, endsSoon, hot], meta);
			expect(selected.map((a) => a.name)).toEqual([
				"hot",
				"ends-soon",
				"ends-later",
				"fresh",
			]);
		});

		it("keeps an exhausted extra-usage seat trailing even when only it has an active 7d window", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
				ratelimit_7d_reset: Date.now() + 3 * 86_400_000,
			});
			const fresh = createAccount("b", "rek", {
				ratelimit_7d_reset: Date.now() - 1000,
			});

			const selected = strategy.select([reese, fresh], meta);
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

	describe("7-day exhaustion block", () => {
		const future = Date.now() + 60 * 60 * 1000;

		it("excludes a flat-rate seat whose 7d quota is maxed, even with a fresh 5h window", () => {
			const strategy = makeStrategy();
			const blocked = createAccount("a", "blocked", {
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
				// 5h window rolled over → would otherwise look fresh and available.
				ratelimit_5h_utilization: 0,
				ratelimit_5h_reset: Date.now() - 1000,
			});
			const ok = createAccount("b", "ok", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			const selected = strategy.select([blocked, ok], meta);
			expect(selected.map((a) => a.name)).toEqual(["ok"]);
		});

		it("re-includes a 7d-maxed seat once its 7d window has reset", () => {
			const strategy = makeStrategy();
			const recovered = createAccount("a", "recovered", {
				// Stored util still 1.0 but the window already reset → not blocked.
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: Date.now() - 1000,
			});

			expect(strategy.select([recovered], meta).map((a) => a.name)).toEqual([
				"recovered",
			]);
		});

		it("does not 7d-block the extra-usage seat (it can serve on overage)", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
			});
			const blocked = createAccount("b", "rek", {
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
			});

			// rek is 7d-blocked; reese is exempt → reese is the only selectable seat.
			expect(
				strategy.select([reese, blocked], meta).map((a) => a.name),
			).toEqual(["reese"]);
		});

		it("does not 7d-block a never-seen account (null util)", () => {
			const strategy = makeStrategy();
			const unseen = createAccount("a", "unseen");
			expect(strategy.select([unseen], meta).map((a) => a.name)).toEqual([
				"unseen",
			]);
		});

		it("drops a flat-rate account from its session when 7d fills mid-session", () => {
			const strategy = makeStrategy();
			// 'sticky' holds the active session but its 7d quota just filled →
			// no longer selectable, so traffic falls over to 'fresh'.
			const sticky = createAccount("a", "sticky", {
				session_start: Date.now() - 1000,
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
			});
			const fresh = createAccount("b", "fresh", {
				// Has an older unexpired session, so without a forced session
				// advance the exhausted seat would stay most-recent and re-fire.
				session_start: Date.now() - 60_000,
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			expect(strategy.select([sticky, fresh], meta)[0].name).toBe("fresh");
			// Stickiness must move to 'fresh': the next request continues on it
			// rather than re-identifying the exhausted seat and dropping again.
			expect(strategy.select([sticky, fresh], meta)[0].name).toBe("fresh");
			expect(fresh.session_start).toBeGreaterThan(sticky.session_start ?? 0);
		});

		it("returns empty (and does not advance its session) when the only account is 7d-exhausted", () => {
			const strategy = makeStrategy();
			const started = Date.now() - 1000;
			const onlyAcct = createAccount("a", "only", {
				session_start: started,
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
			});

			// No selectable replacement → empty result, and the dropped account's
			// session is left untouched (no forced new session that would re-fire
			// the drop log every subsequent request).
			expect(strategy.select([onlyAcct], meta)).toEqual([]);
			expect(onlyAcct.session_start).toBe(started);
		});

		it("does not 7d-block an account whose 7d reset is unknown (null) even at high util", () => {
			const strategy = makeStrategy();
			// util at the cap but reset unknown (e.g. first poll carried util, no
			// reset) → must NOT hard-exclude; a real 429 would catch a genuinely
			// maxed seat instead.
			const unknownReset = createAccount("a", "unknown-reset", {
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: null,
			});
			expect(strategy.select([unknownReset], meta).map((a) => a.name)).toEqual([
				"unknown-reset",
			]);
		});

		it("does not take the 7d-drop path for an account that is also rate-limited", () => {
			const strategy = makeStrategy();
			// Active account is rate-limited AND 7d-exhausted: the rate-limit path
			// owns it (no forced 7d-drop), and traffic still falls over to 'fresh'.
			const limited = createAccount("a", "limited", {
				session_start: Date.now() - 1000,
				rate_limited_until: Date.now() + 60_000,
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
			});
			const fresh = createAccount("b", "fresh", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			expect(strategy.select([limited, fresh], meta)[0].name).toBe("fresh");
		});
	});

	describe("extra-usage seat balanced until full", () => {
		const future = Date.now() + 60 * 60 * 1000;

		it("balances the extra-usage seat like a normal account below the cap", () => {
			const strategy = makeStrategy(["reese"]);
			// reese has more burn than rek and is under the cap → normal burn-down
			// ranks it FIRST, proving it is not forced to last place while it has room.
			const reese = createAccount("a", "reese", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			expect(strategy.select([reese, rek], meta).map((a) => a.name)).toEqual([
				"reese",
				"rek",
			]);
		});

		it("flips the extra-usage seat to last resort once its 5h window is full", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			expect(strategy.select([reese, rek], meta).map((a) => a.name)).toEqual([
				"rek",
				"reese",
			]);
		});

		it("does not preempt the extra-usage seat while it is under the cap", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				session_start: Date.now() - 1000,
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			// reese holds the session and is still under cap → normal sticky, no preempt.
			expect(strategy.select([reese, rek], meta)[0].name).toBe("reese");
		});

		it("preempts off the extra-usage seat the moment it crosses the cap mid-session", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				session_start: Date.now() - 1000,
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			expect(strategy.select([reese, rek], meta)[0].name).toBe("rek");
		});

		it("keeps serving the extra-usage seat on overage when every other seat is exhausted", () => {
			const strategy = makeStrategy(["reese"]);
			// reese full (acts as last resort) but is the only option: rek is 7d-blocked.
			const reese = createAccount("a", "reese", {
				session_start: Date.now() - 1000,
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
			});
			const blocked = createAccount("b", "rek", {
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
			});

			expect(
				strategy.select([reese, blocked], meta).map((a) => a.name),
			).toEqual(["reese"]);
		});

		it("does not treat a rolled-over 5h window as full (no preempt off reese)", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				session_start: Date.now() - 1000,
				// util 1.0 but the window already reset → not maxed → normal sticky.
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: Date.now() - 1000,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			expect(strategy.select([reese, rek], meta)[0].name).toBe("reese");
		});
	});

	describe("previewSelectionOrder", () => {
		const future = Date.now() + 60 * 60 * 1000;

		// name -> entry, for readable assertions.
		function order(strategy: SessionStrategy, accounts: Account[]) {
			const entries = strategy.previewSelectionOrder(accounts);
			const byId = new Map(entries.map((e) => [e.id, e]));
			return new Map(accounts.map((a) => [a.name, byId.get(a.id)]));
		}

		it("leads with the continuing active session, then the next seat", () => {
			const strategy = makeStrategy();
			const act = createAccount("a", "act", {
				session_start: Date.now() - 1000,
			});
			const cand = createAccount("b", "cand", {
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
			});

			const o = order(strategy, [act, cand]);
			expect(o.get("act")).toMatchObject({ rank: 1, status: "active" });
			expect(o.get("cand")).toMatchObject({ rank: 2, status: "next" });
		});

		it("ranks candidates by burn-down (highest 5h util first)", () => {
			const strategy = makeStrategy();
			const hi = createAccount("a", "hi", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});
			const mid = createAccount("b", "mid", {
				ratelimit_5h_utilization: 0.5,
				ratelimit_5h_reset: future,
			});
			const lo = createAccount("c", "lo", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			const o = order(strategy, [lo, hi, mid]);
			expect(o.get("hi")).toMatchObject({ rank: 1, status: "next" });
			expect(o.get("mid")).toMatchObject({ rank: 2, status: "candidate" });
			expect(o.get("lo")).toMatchObject({ rank: 3, status: "candidate" });
		});

		it("treats an extra-usage seat under its cap as a normal candidate", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				ratelimit_5h_utilization: 0.9,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			const o = order(strategy, [reese, rek]);
			// Under cap, reese ranks normally (higher burn-down) → next, not last.
			expect(o.get("reese")).toMatchObject({ rank: 1, status: "next" });
			expect(o.get("rek")).toMatchObject({ rank: 2, status: "candidate" });
		});

		it("marks an extra-usage seat at its cap as last-resort and trailing", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			const o = order(strategy, [reese, rek]);
			expect(o.get("rek")).toMatchObject({ rank: 1, status: "next" });
			expect(o.get("reese")).toMatchObject({ rank: 2, status: "last-resort" });
		});

		it("shows a preempted extra-usage session as last-resort behind the next seat", () => {
			const strategy = makeStrategy(["reese"]);
			const reese = createAccount("a", "reese", {
				session_start: Date.now() - 1000,
				ratelimit_5h_utilization: 1,
				ratelimit_5h_reset: future,
			});
			const rek = createAccount("b", "rek", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});

			const o = order(strategy, [reese, rek]);
			expect(o.get("rek")).toMatchObject({ rank: 1, status: "next" });
			expect(o.get("reese")).toMatchObject({ rank: 2, status: "last-resort" });
		});

		it("excludes blocked / rate-limited / paused accounts with a null rank", () => {
			const strategy = makeStrategy();
			const ok = createAccount("a", "ok", {
				ratelimit_5h_utilization: 0.2,
				ratelimit_5h_reset: future,
			});
			const blocked = createAccount("b", "blocked", {
				ratelimit_7d_utilization: 1,
				ratelimit_7d_reset: future,
			});
			const limited = createAccount("c", "limited", {
				rate_limited_until: Date.now() + 60_000,
			});
			const paused = createAccount("d", "paused", { paused: true });

			const o = order(strategy, [ok, blocked, limited, paused]);
			expect(o.get("ok")).toMatchObject({ rank: 1, status: "next" });
			expect(o.get("blocked")).toMatchObject({
				rank: null,
				status: "blocked-7d",
			});
			expect(o.get("limited")).toMatchObject({
				rank: null,
				status: "rate-limited",
			});
			expect(o.get("paused")).toMatchObject({ rank: null, status: "paused" });
		});

		it("returns an entry for every account", () => {
			const strategy = makeStrategy();
			const accounts = [
				createAccount("a", "a"),
				createAccount("b", "b", { paused: true }),
			];
			expect(strategy.previewSelectionOrder(accounts)).toHaveLength(2);
		});

		it("ranked order matches what select() would return (anti-drift)", () => {
			const strategy = makeStrategy(["reese"]);
			const accounts = [
				createAccount("a", "reese", {
					ratelimit_5h_utilization: 1,
					ratelimit_5h_reset: future,
				}),
				createAccount("b", "hi", {
					ratelimit_5h_utilization: 0.9,
					ratelimit_5h_reset: future,
				}),
				createAccount("c", "lo", {
					ratelimit_5h_utilization: 0.3,
					ratelimit_5h_reset: future,
				}),
				createAccount("d", "blocked", {
					ratelimit_7d_utilization: 1,
					ratelimit_7d_reset: future,
				}),
			];

			// preview() does not mutate, so capture it first, then run select().
			const entries = strategy.previewSelectionOrder(accounts);
			const nameById = new Map(accounts.map((a) => [a.id, a.name]));
			const rankedNames = entries
				.filter((e) => e.rank != null)
				.sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0))
				.map((e) => nameById.get(e.id));

			const selectedNames = strategy.select(accounts, meta).map((a) => a.name);
			expect(rankedNames).toEqual(selectedNames);
		});
	});
});
