import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";

function getTableColumns(db: Database, tableName: string) {
	return db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
		name: string;
		type: string;
		notnull: 0 | 1;
		dflt_value: string | null;
		pk: 0 | 1;
	}>;
}

function getTableIndexes(db: Database, tableName: string) {
	return db.query(`PRAGMA index_list(${tableName})`).all() as Array<{
		name: string;
		unique: 0 | 1;
		origin: string;
		partial: 0 | 1;
	}>;
}

function createV1Schema(db: Database): void {
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT NOT NULL,
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			account_tier INTEGER DEFAULT 1
		)
	`);

	db.run(`
		CREATE TABLE requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			account_used TEXT,
			agent_used TEXT,
			status_code INTEGER,
			success BOOLEAN,
			error_message TEXT,
			response_time_ms INTEGER,
			failover_attempts INTEGER DEFAULT 0,
			model TEXT,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cost_usd REAL DEFAULT 0,
			output_tokens_per_second REAL,
			input_tokens INTEGER DEFAULT 0,
			cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0
		)
	`);

	db.run(`
		CREATE TABLE agent_preferences (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			model TEXT NOT NULL
		)
	`);

	db.run(`
		CREATE TABLE request_payloads (
			id TEXT PRIMARY KEY,
			json TEXT NOT NULL
		)
	`);
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

describe("database schema", () => {
	it("creates the fresh v2 schema for accounts and requests", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const tables = db
				.query("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as Array<{ name: string }>;
			const tableNames = tables.map((table) => table.name);
			expect(tableNames).not.toContain("agent_preferences");
			expect(tableNames).toContain("auth_sessions");
			expect(tableNames).not.toContain("oauth_sessions");

			const accountColumns = getTableColumns(db, "accounts");
			expect(accountColumns.map((column) => column.name)).toEqual([
				"id",
				"name",
				"provider",
				"auth_method",
				"base_url",
				"api_key",
				"refresh_token",
				"access_token",
				"expires_at",
				"created_at",
				"last_used",
				"request_count",
				"total_requests",
				"weight",
				"rate_limited_until",
				"session_start",
				"session_request_count",
				"paused",
				"rate_limit_reset",
				"rate_limit_status",
				"rate_limit_remaining",
				"ratelimit_5h_utilization",
				"ratelimit_5h_reset",
				"ratelimit_5h_status",
				"ratelimit_7d_utilization",
				"ratelimit_7d_reset",
				"ratelimit_7d_status",
				"overage_status",
			]);

			const providerColumn = accountColumns.find(
				(column) => column.name === "provider",
			);
			expect(providerColumn).toMatchObject({
				type: "TEXT",
				notnull: 1,
				dflt_value: null,
			});

			const authMethodColumn = accountColumns.find(
				(column) => column.name === "auth_method",
			);
			expect(authMethodColumn).toMatchObject({
				type: "TEXT",
				notnull: 1,
			});

			const refreshTokenColumn = accountColumns.find(
				(column) => column.name === "refresh_token",
			);
			expect(refreshTokenColumn?.notnull).toBe(0);

			const weightColumn = accountColumns.find(
				(column) => column.name === "weight",
			);
			expect(weightColumn).toMatchObject({
				type: "INTEGER",
				notnull: 1,
				dflt_value: "1",
			});

			db.run(
				`INSERT INTO accounts (
					id, name, provider, auth_method, base_url, api_key, refresh_token, access_token,
					expires_at, created_at, last_used, request_count, total_requests, weight
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"api-key-account",
					"API Key Account",
					"anthropic",
					"api_key",
					null,
					"test-key",
					null,
					null,
					null,
					Date.now(),
					null,
					0,
					0,
					1,
				],
			);

			const requestColumns = getTableColumns(db, "requests");
			expect(requestColumns.map((column) => column.name)).toContain("provider");
			expect(requestColumns.map((column) => column.name)).toContain(
				"upstream_path",
			);
			expect(requestColumns.map((column) => column.name)).toContain(
				"reasoning_tokens",
			);
			expect(requestColumns.map((column) => column.name)).not.toContain(
				"agent_used",
			);

			expect(
				requestColumns.find((column) => column.name === "provider"),
			).toMatchObject({
				type: "TEXT",
				notnull: 1,
			});
			expect(
				requestColumns.find((column) => column.name === "upstream_path"),
			).toMatchObject({
				type: "TEXT",
				notnull: 1,
			});

			const authSessionColumns = getTableColumns(db, "auth_sessions");
			expect(authSessionColumns.map((column) => column.name)).toEqual([
				"id",
				"provider",
				"auth_method",
				"account_name",
				"state_json",
				"created_at",
				"expires_at",
			]);
			expect(
				authSessionColumns.find((column) => column.name === "created_at"),
			).toMatchObject({
				type: "TEXT",
				notnull: 1,
			});
			expect(
				authSessionColumns.find((column) => column.name === "expires_at"),
			).toMatchObject({
				type: "TEXT",
				notnull: 1,
			});

			const accountIndexes = getTableIndexes(db, "accounts");
			expect(accountIndexes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						unique: 1,
					}),
				]),
			);

			expect(() =>
				db.run(
					`INSERT INTO accounts (
						id, name, provider, auth_method, base_url, api_key, refresh_token, access_token,
						expires_at, created_at, last_used, request_count, total_requests, weight
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						"api-key-account-duplicate",
						"API Key Account",
						"openai",
						"api_key",
						null,
						"test-key-2",
						null,
						null,
						null,
						Date.now(),
						null,
						0,
						0,
						1,
					],
				),
			).toThrow(/accounts\.name|UNIQUE constraint failed/);
		} finally {
			db.close();
		}
	});

	it("migrates a v1 database to v2 and preserves account and request data", () => {
		const db = new Database(":memory:");

		try {
			createV1Schema(db);

			db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token, expires_at,
					created_at, last_used, request_count, total_requests, account_tier
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"account-1",
					"Legacy Account",
					null,
					null,
					"refresh-token",
					"access-token",
					123456789,
					111111111,
					222222222,
					3,
					7,
					5,
				],
			);

			db.run(
				`INSERT INTO requests (
					id, timestamp, method, path, account_used, agent_used, status_code, success,
					error_message, response_time_ms, failover_attempts, model, prompt_tokens,
					completion_tokens, total_tokens, cost_usd, output_tokens_per_second,
					input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"request-1",
					333333333,
					"POST",
					"/v1/messages",
					"account-1",
					"legacy-agent",
					200,
					1,
					null,
					150,
					2,
					"claude-3-5-sonnet",
					10,
					20,
					30,
					0.12,
					4.5,
					8,
					1,
					1,
					20,
				],
			);

			runMigrations(db);

			const tables = db
				.query("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as Array<{ name: string }>;
			expect(tables.map((table) => table.name)).not.toContain(
				"agent_preferences",
			);

			const migratedAccount = db
				.query(
					`SELECT
						id, name, provider, auth_method, base_url, api_key, refresh_token, access_token,
						expires_at, created_at, last_used, request_count, total_requests, weight
					FROM accounts
					WHERE id = ?`,
				)
				.get("account-1") as {
				id: string;
				name: string;
				provider: string;
				auth_method: string;
				base_url: string | null;
				api_key: string | null;
				refresh_token: string;
				access_token: string;
				expires_at: number;
				created_at: number;
				last_used: number;
				request_count: number;
				total_requests: number;
				weight: number;
			};

			expect(migratedAccount).toEqual({
				id: "account-1",
				name: "Legacy Account",
				provider: "anthropic",
				auth_method: "oauth",
				base_url: null,
				api_key: null,
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: 123456789,
				created_at: 111111111,
				last_used: 222222222,
				request_count: 3,
				total_requests: 7,
				weight: 5,
			});

			const migratedRequest = db
				.query(
					`SELECT
						id, timestamp, method, path, provider, upstream_path, account_used, status_code,
						success, error_message, response_time_ms, failover_attempts, model,
						prompt_tokens, completion_tokens, total_tokens, cost_usd,
						output_tokens_per_second, input_tokens, cache_read_input_tokens,
						cache_creation_input_tokens, output_tokens, reasoning_tokens
					FROM requests
					WHERE id = ?`,
				)
				.get("request-1") as {
				id: string;
				timestamp: number;
				method: string;
				path: string;
				provider: string;
				upstream_path: string;
				account_used: string | null;
				status_code: number;
				success: 0 | 1;
				error_message: string | null;
				response_time_ms: number;
				failover_attempts: number;
				model: string;
				prompt_tokens: number;
				completion_tokens: number;
				total_tokens: number;
				cost_usd: number;
				output_tokens_per_second: number;
				input_tokens: number;
				cache_read_input_tokens: number;
				cache_creation_input_tokens: number;
				output_tokens: number;
				reasoning_tokens: number;
			};

			expect(migratedRequest).toEqual({
				id: "request-1",
				timestamp: 333333333,
				method: "POST",
				path: "/v1/messages",
				provider: "",
				upstream_path: "",
				account_used: "account-1",
				status_code: 200,
				success: 1,
				error_message: null,
				response_time_ms: 150,
				failover_attempts: 2,
				model: "claude-3-5-sonnet",
				prompt_tokens: 10,
				completion_tokens: 20,
				total_tokens: 30,
				cost_usd: 0.12,
				output_tokens_per_second: 4.5,
				input_tokens: 8,
				cache_read_input_tokens: 1,
				cache_creation_input_tokens: 1,
				output_tokens: 20,
				reasoning_tokens: 0,
			});
		} finally {
			db.close();
		}
	});

	it("backfills conversation linkage columns from stored payloads", () => {
		const db = new Database(":memory:");

		try {
			createV1Schema(db);

			db.run(
				`INSERT INTO requests (
					id, timestamp, method, path, account_used, agent_used, status_code, success,
					error_message, response_time_ms, failover_attempts, model, prompt_tokens,
					completion_tokens, total_tokens, cost_usd, output_tokens_per_second,
					input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"request-root",
					1_000,
					"POST",
					"/v1/openai/responses",
					null,
					"legacy-agent",
					200,
					1,
					null,
					10,
					0,
					"gpt-5.4",
					1,
					1,
					2,
					0,
					1,
					1,
					0,
					0,
					1,
				],
			);
			db.run(
				`INSERT INTO requests (
					id, timestamp, method, path, account_used, agent_used, status_code, success,
					error_message, response_time_ms, failover_attempts, model, prompt_tokens,
					completion_tokens, total_tokens, cost_usd, output_tokens_per_second,
					input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"request-child",
					2_000,
					"POST",
					"/v1/openai/responses",
					null,
					"legacy-agent",
					200,
					1,
					null,
					10,
					0,
					"gpt-5.4",
					1,
					1,
					2,
					0,
					1,
					1,
					0,
					0,
					1,
				],
			);

			db.run(`INSERT INTO request_payloads (id, json) VALUES (?, ?)`, [
				"request-root",
				JSON.stringify({
					id: "request-root",
					request: {
						headers: {},
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "root",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-root"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 1_000 },
						account: { id: null },
						transport: { success: true },
					},
				}),
			]);
			db.run(`INSERT INTO request_payloads (id, json) VALUES (?, ?)`, [
				"request-child",
				JSON.stringify({
					id: "request-child",
					request: {
						headers: {},
						body: encode(
							JSON.stringify({
								type: "response.create",
								input: "child",
								previous_response_id: "resp-root",
							}),
						),
					},
					response: {
						status: 200,
						headers: {},
						body: encode(
							[
								"event: response.created",
								'data: {"type":"response.created","response":{"id":"resp-child"}}',
								"",
							].join("\n"),
						),
					},
					meta: {
						trace: { timestamp: 2_000 },
						account: { id: null },
						transport: { success: true },
					},
				}),
			]);

			runMigrations(db);

			const rows = db
				.query(
					`
						SELECT id, response_id, previous_response_id, response_chain_id
						FROM requests
						ORDER BY timestamp ASC
					`,
				)
				.all() as Array<{
				id: string;
				response_id: string | null;
				previous_response_id: string | null;
				response_chain_id: string | null;
			}>;

			expect(rows).toEqual([
				{
					id: "request-root",
					response_id: "resp-root",
					previous_response_id: null,
					response_chain_id: "resp-root",
				},
				{
					id: "request-child",
					response_id: "resp-child",
					previous_response_id: "resp-root",
					response_chain_id: "resp-root",
				},
			]);
		} finally {
			db.close();
		}
	});

	it("renames duplicate legacy account names before creating the unique index", () => {
		const db = new Database(":memory:");

		try {
			createV1Schema(db);

			const legacyAccounts = [
				["account-1", "Legacy Account", 111111111],
				["account-2", "Legacy Account", 222222222],
				["account-3", "Legacy Account-2", 333333333],
				["account-4", "Legacy Account", 444444444],
			] as const;

			for (const [id, name, createdAt] of legacyAccounts) {
				db.run(
					`INSERT INTO accounts (
						id, name, provider, api_key, refresh_token, access_token, expires_at,
						created_at, last_used, request_count, total_requests, account_tier
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						name,
						"anthropic",
						null,
						`refresh-${id}`,
						`access-${id}`,
						123456789,
						createdAt,
						null,
						0,
						0,
						1,
					],
				);
			}

			expect(() => runMigrations(db)).not.toThrow();

			const migratedAccounts = db
				.query("SELECT id, name FROM accounts ORDER BY created_at ASC")
				.all() as Array<{
				id: string;
				name: string;
			}>;

			expect(migratedAccounts).toEqual([
				{ id: "account-1", name: "Legacy Account" },
				{ id: "account-2", name: "Legacy Account-3" },
				{ id: "account-3", name: "Legacy Account-2" },
				{ id: "account-4", name: "Legacy Account-4" },
			]);

			const duplicateNames = db
				.query(
					`
						SELECT name, COUNT(*) as count
						FROM accounts
						GROUP BY name
						HAVING COUNT(*) > 1
					`,
				)
				.all() as Array<{ name: string; count: number }>;
			expect(duplicateNames).toHaveLength(0);

			const accountIndexes = getTableIndexes(db, "accounts");
			expect(accountIndexes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "idx_accounts_name_unique",
						unique: 1,
					}),
				]),
			);
		} finally {
			db.close();
		}
	});

	it("adds utilization columns to a legacy accounts table and is idempotent", () => {
		const db = new Database(":memory:");
		try {
			createV1Schema(db);
			const utilColumns = [
				"ratelimit_5h_utilization",
				"ratelimit_5h_reset",
				"ratelimit_5h_status",
				"ratelimit_7d_utilization",
				"ratelimit_7d_reset",
				"ratelimit_7d_status",
				"overage_status",
			];

			// Old schema lacks every utilization column.
			const before = getTableColumns(db, "accounts").map((c) => c.name);
			for (const col of utilColumns) expect(before).not.toContain(col);

			expect(() => runMigrations(db)).not.toThrow();
			const after = getTableColumns(db, "accounts").map((c) => c.name);
			for (const col of utilColumns) expect(after).toContain(col);

			// Running again must not throw or duplicate columns.
			expect(() => runMigrations(db)).not.toThrow();
			const final = getTableColumns(db, "accounts").map((c) => c.name);
			for (const col of utilColumns) {
				expect(final.filter((c) => c === col)).toHaveLength(1);
			}
		} finally {
			db.close();
		}
	});
});
