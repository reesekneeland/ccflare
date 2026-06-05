import { useEffect, useState } from "react";

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
