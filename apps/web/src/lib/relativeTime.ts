import { useEffect, useState } from "react";

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

/**
 * A ticking clock shared by countdown displays. Returns `Date.now()` refreshed
 * every `intervalMs`. Each caller holds one interval; callers are bounded by the
 * number of rendered account cards, so the total count stays small.
 */
export function useNow(intervalMs = 10000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(interval);
	}, [intervalMs]);
	return now;
}
