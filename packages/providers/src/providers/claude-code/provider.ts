import { Logger } from "@ccflare/logger";
import {
	type Account,
	type AccountUtilizationUpdate,
	getProviderDefaultBaseUrl,
} from "@ccflare/types";
import { deleteTransportHeaders } from "../../base";
import {
	executeTokenRefresh,
	type RefreshRequestConfig,
} from "../../token-refresh";
import type { TokenRefreshResult } from "../../types";
import { AnthropicProvider } from "../anthropic/provider";
import { CLAUDE_CODE_OAUTH_TOKEN_URL, ClaudeCodeOAuthProvider } from "./oauth";

const log = new Logger("ClaudeCodeProvider");
const PROVIDER_NAME = "claude-code" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);

// Zero-cost account usage endpoint (no billed message). Returns 5h/7d quota
// utilization as 0-100 percentages; we normalize to 0-1 to match the
// `anthropic-ratelimit-unified-*` headers parsed on the message path.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_BETA_HEADER = "oauth-2025-04-20";
// Utilization (0-1) at/above which we surface a soft warning in the dashboard,
// since this endpoint returns a number but no allowed/allowed_warning status.
const USAGE_WARN_AT = 0.8;

interface UsageWindow {
	utilization?: number | null;
	resets_at?: string | null;
}

/** Normalize one usage window (0-100 pct) into util(0-1)/reset(ms)/derived status. */
function usageWindowFields(win: UsageWindow | null | undefined): {
	utilization?: number;
	reset?: number;
	status?: string;
} {
	if (!win || typeof win.utilization !== "number") return {};
	const utilization = win.utilization / 100;
	const resetMs = win.resets_at ? Date.parse(win.resets_at) : Number.NaN;
	return {
		utilization,
		reset: Number.isFinite(resetMs) ? resetMs : undefined,
		status: utilization >= USAGE_WARN_AT ? "allowed_warning" : "allowed",
	};
}

const CLAUDE_CODE_REFRESH_CONFIG: RefreshRequestConfig = {
	tokenUrl: CLAUDE_CODE_OAUTH_TOKEN_URL,
	contentType: "application/json",
	buildBody(refreshToken: string, clientId: string) {
		return JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId,
		});
	},
	parseTokens(json: Record<string, unknown>, account: Account) {
		const refreshToken =
			(json.refresh_token as string) || (account.refresh_token ?? "");
		if (!json.refresh_token) {
			log.warn(
				`Claude Code refresh endpoint did not return a refresh_token for ${account.name} - continuing with previous one`,
			);
		}
		return {
			accessToken: json.access_token as string,
			expiresAt: Date.now() + (json.expires_in as number) * 1000,
			refreshToken,
		};
	},
};

export class ClaudeCodeProvider extends AnthropicProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;

	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		return executeTokenRefresh(
			account,
			clientId,
			CLAUDE_CODE_REFRESH_CONFIG,
			log,
		);
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);

		if (account?.access_token) {
			newHeaders.set("Authorization", `Bearer ${account.access_token}`);
		}

		// Remove api_key header -- Claude Code uses OAuth Bearer tokens
		newHeaders.delete("x-api-key");

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		return new ClaudeCodeOAuthProvider();
	}

	async fetchUsage(
		accessToken: string,
	): Promise<AccountUtilizationUpdate | null> {
		let res: Response;
		try {
			res = await fetch(USAGE_URL, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"anthropic-beta": USAGE_BETA_HEADER,
				},
			});
		} catch (err) {
			log.warn(`Usage fetch failed (network): ${err}`);
			return null;
		}
		if (!res.ok) {
			log.warn(`Usage fetch returned HTTP ${res.status}`);
			return null;
		}
		let data: {
			five_hour?: UsageWindow | null;
			seven_day?: UsageWindow | null;
			extra_usage?: { is_enabled?: boolean; disabled_reason?: string | null };
		};
		try {
			data = await res.json();
		} catch (err) {
			log.warn(`Usage fetch returned invalid JSON: ${err}`);
			return null;
		}

		const five = usageWindowFields(data.five_hour);
		const seven = usageWindowFields(data.seven_day);
		if (five.utilization === undefined && seven.utilization === undefined) {
			return null;
		}
		const eu = data.extra_usage;
		return {
			fiveHourUtilization: five.utilization,
			fiveHourReset: five.reset,
			fiveHourStatus: five.status,
			sevenDayUtilization: seven.utilization,
			sevenDayReset: seven.reset,
			sevenDayStatus: seven.status,
			overageStatus: eu?.is_enabled
				? (eu.disabled_reason ?? "enabled")
				: "disabled",
		};
	}
}
