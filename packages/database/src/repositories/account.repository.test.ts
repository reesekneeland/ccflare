import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { AccountRepository } from "./account.repository";

describe("AccountRepository", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new AccountRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates API key accounts and supports lookup/count queries", () => {
		const created = repository.create({
			name: "primary-anthropic",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
			base_url: "https://anthropic.internal",
		});

		expect(created).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				name: "primary-anthropic",
				provider: "anthropic",
				auth_method: "api_key",
				api_key: "sk-ant-test",
				base_url: "https://anthropic.internal",
				weight: 1,
				request_count: 0,
				total_requests: 0,
				paused: false,
			}),
		);
		expect(repository.count()).toBe(1);
		expect(repository.findById(created.id)).toEqual(created);
		expect(repository.findByName("primary-anthropic")).toEqual(created);
	});

	it("creates OAuth accounts and filters them by provider", () => {
		repository.create({
			name: "codex-main",
			provider: "codex",
			auth_method: "oauth",
			access_token: "codex-access-token",
			refresh_token: "codex-refresh-token",
			expires_at: 123_456,
		});
		repository.create({
			name: "openai-main",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-openai-test",
		});

		const providerAccounts = repository.findByProvider("codex");

		expect(providerAccounts).toHaveLength(1);
		expect(providerAccounts[0]).toEqual(
			expect.objectContaining({
				name: "codex-main",
				provider: "codex",
				auth_method: "oauth",
				access_token: "codex-access-token",
				refresh_token: "codex-refresh-token",
				expires_at: 123_456,
			}),
		);
	});

	it("updates existing accounts and returns the updated row", () => {
		const created = repository.create({
			name: "rename-me",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-openai-test",
		});

		const updated = repository.update(created.id, {
			name: "renamed-account",
			base_url: "https://custom.endpoint/v1",
		});

		expect(updated).toEqual(
			expect.objectContaining({
				id: created.id,
				name: "renamed-account",
				base_url: "https://custom.endpoint/v1",
				api_key: "sk-openai-test",
			}),
		);
		expect(repository.findByName("rename-me")).toBeNull();
		expect(repository.findByName("renamed-account")).toEqual(updated);
	});

	it("deletes accounts by id and reports whether anything changed", () => {
		const created = repository.create({
			name: "delete-me",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
		});

		expect(repository.delete(created.id)).toBe(true);
		expect(repository.findById(created.id)).toBeNull();
		expect(repository.count()).toBe(0);
		expect(repository.delete(created.id)).toBe(false);
	});

	it("updateUtilization writes only defined fields, preserving the other window", () => {
		const created = repository.create({
			name: "util-account",
			provider: "claude-code",
			auth_method: "oauth",
			access_token: "tok",
			refresh_token: "ref",
		});

		repository.updateUtilization(created.id, {
			fiveHourUtilization: 0.5,
			fiveHourReset: 1_000,
			fiveHourStatus: "allowed",
			sevenDayUtilization: 0.9,
			sevenDayReset: 2_000,
			sevenDayStatus: "allowed_warning",
			overageStatus: "enabled",
		});

		// Partial update: only the 5h window reported — 7d + overage must survive.
		repository.updateUtilization(created.id, {
			fiveHourUtilization: 0.6,
			fiveHourReset: 1_500,
			fiveHourStatus: "allowed",
		});

		const account = repository.findById(created.id);
		expect(account).toEqual(
			expect.objectContaining({
				ratelimit_5h_utilization: 0.6,
				ratelimit_5h_reset: 1_500,
				ratelimit_7d_utilization: 0.9,
				ratelimit_7d_reset: 2_000,
				ratelimit_7d_status: "allowed_warning",
				overage_status: "enabled",
			}),
		);

		// Empty update is a no-op, not a wipe.
		repository.updateUtilization(created.id, {});
		expect(repository.findById(created.id)).toEqual(account);
	});

	it("rejects duplicate account names", () => {
		repository.create({
			name: "duplicate-name",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
		});

		expect(() =>
			repository.create({
				name: "duplicate-name",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-test",
			}),
		).toThrow(/accounts\.name|UNIQUE constraint failed/);
	});
});
