import { formatRemaining } from "@ccflare/ui";
import { useNow } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { Progress } from "../ui/progress";

interface RateLimitProgressProps {
	resetIso: string | null;
	className?: string;
}

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds

export function RateLimitProgress({
	resetIso,
	className,
}: RateLimitProgressProps) {
	const now = useNow();

	if (!resetIso) return null;

	const resetTime = new Date(resetIso).getTime();
	const startTime = resetTime - WINDOW_MS;
	const elapsed = now - startTime;
	const percentage = Math.min(100, Math.max(0, (elapsed / WINDOW_MS) * 100));
	const remainingMs = Math.max(0, resetTime - now);
	const remaining = formatRemaining(resetTime, now);
	const timeText =
		remainingMs <= 0 ? "Ready to refresh" : `${remaining} until refresh`;

	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">Rate limit window</span>
				<span className="text-xs font-medium text-muted-foreground">
					{percentage.toFixed(0)}%
				</span>
			</div>
			<Progress value={percentage} className="h-2" />
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">{timeText}</span>
				{remainingMs > 0 && (
					<span className="text-xs text-muted-foreground">
						Resets at {new Date(resetTime).toLocaleTimeString()}
					</span>
				)}
			</div>
		</div>
	);
}
