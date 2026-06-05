import { formatRemaining } from "@ccflare/ui";
import { useNow } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { Progress } from "../ui/progress";

interface UtilizationBarsProps {
	util5h: number | null;
	reset5h: string | null;
	status5h: string | null;
	util7d: number | null;
	reset7d: string | null;
	status7d: string | null;
	className?: string;
}

interface QuotaBarProps {
	label: string;
	ariaLabel: string;
	utilization: number | null;
	resetIso: string | null;
	status: string | null;
	now: number;
}

function QuotaBar({
	label,
	ariaLabel,
	utilization,
	resetIso,
	status,
	now,
}: QuotaBarProps) {
	// Never-seen account: show the label with an em-dash and no bar.
	if (utilization == null) {
		return (
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">{label}</span>
				<span className="text-xs text-muted-foreground">—</span>
			</div>
		);
	}

	const resetMs = resetIso ? new Date(resetIso).getTime() : null;
	// Staleness: a window past its reset has rolled over; the stored fraction is
	// stale until the next request, so display it as 0 rather than the old value.
	const rolledOver = resetMs != null && now >= resetMs;
	const effective = rolledOver ? 0 : utilization;
	const percentage = Math.min(100, Math.max(0, effective * 100));
	const isWarning = status === "allowed_warning";

	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">
					{label}
					{isWarning && <span className="sr-only"> (near limit)</span>}
				</span>
				<span className="text-xs font-medium text-muted-foreground">
					{percentage.toFixed(0)}%
				</span>
			</div>
			<Progress
				value={percentage}
				aria-label={`${ariaLabel}: ${percentage.toFixed(0)}%`}
				className={cn(
					"h-2",
					isWarning ? "[&>div]:bg-amber-500" : "[&>div]:bg-sky-500",
				)}
			/>
			{resetMs != null && (
				<div className="text-xs text-muted-foreground">
					{rolledOver
						? "resetting…"
						: `resets in ${formatRemaining(resetMs, now)}`}
				</div>
			)}
		</div>
	);
}

export function UtilizationBars({
	util5h,
	reset5h,
	status5h,
	util7d,
	reset7d,
	status7d,
	className,
}: UtilizationBarsProps) {
	const now = useNow();

	// Cold-start: no account has served a request yet (everything null). Show a
	// single muted line instead of two em-dash rows.
	if (util5h == null && util7d == null) {
		return (
			<div className={cn("text-xs text-muted-foreground", className)}>
				No utilization data yet
			</div>
		);
	}

	return (
		<div className={cn("space-y-2", className)}>
			<QuotaBar
				label="5h quota"
				ariaLabel="Tokens used in the 5-hour quota"
				utilization={util5h}
				resetIso={reset5h}
				status={status5h}
				now={now}
			/>
			<QuotaBar
				label="7d quota"
				ariaLabel="Tokens used in the 7-day quota"
				utilization={util7d}
				resetIso={reset7d}
				status={status7d}
				now={now}
			/>
		</div>
	);
}
