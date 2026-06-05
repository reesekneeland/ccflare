import { TIME_CONSTANTS } from "@ccflare/core";

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
	if (ms < TIME_CONSTANTS.SECOND) return `${ms}ms`;
	if (ms < TIME_CONSTANTS.MINUTE)
		return `${(ms / TIME_CONSTANTS.SECOND).toFixed(1)}s`;
	if (ms < TIME_CONSTANTS.HOUR)
		return `${(ms / TIME_CONSTANTS.MINUTE).toFixed(1)}m`;
	return `${(ms / TIME_CONSTANTS.HOUR).toFixed(1)}h`;
}

/**
 * Format tokens with locale-aware thousands separator
 */
export function formatTokens(tokens?: number | null): string {
	if (!tokens || tokens === 0) return "0";
	return tokens.toLocaleString();
}

/**
 * Format percentage with specified decimal places
 */
export function formatPercentage(value: number, decimals = 1): string {
	return `${value.toFixed(decimals)}%`;
}

/**
 * Format number with locale-aware thousands separator
 */
export function formatNumber(value: number): string {
	return value.toLocaleString();
}

/**
 * Format timestamp to locale string
 */
export function formatTimestamp(timestamp: number | string): string {
	const date =
		typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
	return date.toLocaleString();
}

/**
 * Format tokens per second with 1 decimal place
 */
export function formatTokensPerSecond(tokensPerSecond?: number | null): string {
	if (!tokensPerSecond || tokensPerSecond === 0) return "0 tok/s";
	return `${tokensPerSecond.toFixed(1)} tok/s`;
}

/**
 * Format the time remaining until `resetMs` (epoch ms) as a compact string:
 * "2h 10m", "45m", or "now" when the deadline has passed. Pure — pass `now` in.
 */
export function formatRemaining(resetMs: number, now: number): string {
	const remainingMs = Math.max(0, resetMs - now);
	if (remainingMs <= 0) return "now";
	const totalMinutes = Math.ceil(remainingMs / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
