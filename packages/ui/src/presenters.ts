import { formatCost } from "@ccflare/core";
import type {
	Request,
	RequestSummary,
	Stats,
	StatsWithAccounts,
} from "@ccflare/types";
import {
	formatAccountRateLimitStatus,
	formatAccountSessionInfo,
} from "./account-display";
import { formatDuration, formatPercentage, formatTokens } from "./formatters";

/**
 * Shape expected by AccountPresenter.
 *
 * This matches AccountResponse from @ccflare/api -- the only shape
 * callers actually pass in (the dashboard web app).  Earlier revisions
 * accepted a three-way union (Account | AccountResponseLike | AccountDisplay)
 * with runtime "in"-operator narrowing, but all non-AccountResponse branches
 * were dead code.
 */
export interface AccountResponseLike {
	requestCount: number;
	totalRequests: number;
	weight: number;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	rateLimitStatus: {
		code: string;
		isLimited: boolean;
		until: string | null;
	};
	rateLimitReset: string | null;
	rateLimitRemaining: number | null;
	sessionInfo: {
		active: boolean;
		startedAt: string | null;
		requestCount: number;
	};
}

/**
 * Account presenter - formats account data for display.
 *
 * Accepts the API response shape (AccountResponseLike / AccountResponse).
 */
export class AccountPresenter {
	constructor(private account: AccountResponseLike) {}

	get weightDisplay(): string {
		return `${this.account.weight || 1}x`;
	}

	get tokenStatus(): "valid" | "expired" {
		return this.account.tokenStatus;
	}

	get rateLimitStatus(): string {
		return formatAccountRateLimitStatus(
			this.account.rateLimitStatus,
			this.account.rateLimitReset,
		);
	}

	get sessionInfo(): string {
		return formatAccountSessionInfo(this.account.sessionInfo);
	}

	get requestCount(): number {
		return this.account.requestCount;
	}

	get totalRequests(): number {
		return this.account.totalRequests;
	}

	get isPaused(): boolean {
		return this.account.paused;
	}

	get isRateLimited(): boolean {
		return this.account.rateLimitStatus.isLimited;
	}
}

/**
 * Request presenter - formats request data for display
 */
export class RequestPresenter {
	constructor(private request: Request | RequestSummary) {}

	get statusDisplay(): string {
		const code = this.request.statusCode;
		if (!code) return "N/A";
		return code.toString();
	}

	get responseTimeDisplay(): string {
		const time = this.request.responseTimeMs;
		if (!time) return "N/A";
		return formatDuration(time);
	}

	get tokensDisplay(): string {
		return formatTokens(this.request.totalTokens);
	}

	get costDisplay(): string {
		return formatCost(this.request.costUsd);
	}

	get isSuccess(): boolean {
		return this.request.success === true;
	}

	get hasTokenUsage(): boolean {
		return Boolean(this.request.inputTokens || this.request.outputTokens);
	}
}

/**
 * Stats presenter - formats stats data for display
 */
export class StatsPresenter {
	constructor(private stats: Stats | StatsWithAccounts) {}

	get successRateDisplay(): string {
		return formatPercentage(this.stats.successRate);
	}

	get avgResponseTimeDisplay(): string {
		return formatDuration(this.stats.avgResponseTime);
	}

	get totalTokensDisplay(): string {
		return formatTokens(this.stats.totalTokens);
	}

	get totalCostDisplay(): string {
		return formatCost(this.stats.totalCostUsd);
	}

	get topModel(): string | null {
		if (!this.stats.topModels || this.stats.topModels.length === 0) {
			return null;
		}
		return this.stats.topModels[0].model;
	}

	get hasAccounts(): boolean {
		return "accounts" in this.stats && this.stats.accounts.length > 0;
	}
}
