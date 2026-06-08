import type { AccountResponse, SelectionStatus } from "@ccflare/api";
import { useNow } from "../../lib/relativeTime";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

const STATUS_LABEL: Record<SelectionStatus, string> = {
	active: "Active",
	next: "Next",
	candidate: "Queued",
	"last-resort": "Last resort",
	"blocked-7d": "Blocked",
	"rate-limited": "Limited",
	paused: "Paused",
};

function badgeVariant(
	status: SelectionStatus,
): "default" | "secondary" | "outline" {
	if (status === "active") return "default";
	if (status === "next") return "secondary";
	return "outline";
}

function badgeClass(status: SelectionStatus): string {
	switch (status) {
		case "last-resort":
			return "border-amber-500 text-amber-600 dark:text-amber-400";
		case "blocked-7d":
		case "rate-limited":
		case "paused":
			return "text-muted-foreground";
		default:
			return "";
	}
}

function pct(u: number | null): string {
	return u == null ? "—" : `${Math.round(u * 100)}%`;
}

/** Compact "in 3h 12m" / "in 45m" / "now" for a future ISO timestamp. */
function formatIn(iso: string | null, now: number): string {
	if (!iso) return "unknown";
	const ms = new Date(iso).getTime() - now;
	if (ms <= 0) return "now";
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `in ${mins}m`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}

function reason(
	account: AccountResponse,
	status: SelectionStatus,
	now: number,
): string {
	switch (status) {
		case "active":
			return `Serving now · ${account.sessionInfo.requestCount} reqs this session`;
		case "next":
			return "Activated next when the current session ends";
		case "candidate":
			return `5h used ${pct(account.utilization5h)} · in burn-down order`;
		case "last-resort":
			return `Extra-usage / overage — used only if all others are exhausted · 5h ${pct(account.utilization5h)}`;
		case "blocked-7d":
			return `7-day quota exhausted (${pct(account.utilization7d)}) · frees up ${formatIn(account.reset7d, now)}`;
		case "rate-limited":
			return `Rate-limited · clears ${formatIn(account.rateLimitStatus.until, now)}`;
		case "paused":
			return "Paused by operator";
	}
}

interface SwitchingOrderProps {
	accounts: AccountResponse[] | undefined;
}

/**
 * Shows the strategy's live activation order — which account serves next and
 * why — sourced from each account's `selection` field (computed server-side by
 * the same logic the proxy uses to pick accounts).
 */
export function SwitchingOrder({ accounts }: SwitchingOrderProps) {
	const now = useNow();
	if (!accounts || accounts.length === 0) return null;

	const withSelection = accounts.filter((a) => a.selection != null);
	if (withSelection.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Switching order</CardTitle>
					<CardDescription>
						Switching order is unavailable right now.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	const activation = withSelection
		.filter((a) => a.selection?.rank != null)
		.sort((x, y) => (x.selection?.rank ?? 0) - (y.selection?.rank ?? 0));
	const excluded = withSelection.filter((a) => a.selection?.rank == null);

	const row = (account: AccountResponse, showRank: boolean) => {
		const sel = account.selection;
		if (!sel) return null;
		return (
			<div
				key={account.id}
				className="flex items-start justify-between gap-3 py-2"
			>
				<div className="flex items-start gap-3">
					{showRank && (
						<span className="mt-0.5 w-6 text-right font-mono text-sm text-muted-foreground">
							{sel.rank}
						</span>
					)}
					<div>
						<p className="font-medium leading-tight">{account.name}</p>
						<p className="text-xs text-muted-foreground">
							{reason(account, sel.status, now)}
						</p>
					</div>
				</div>
				<Badge
					variant={badgeVariant(sel.status)}
					className={badgeClass(sel.status)}
				>
					{STATUS_LABEL[sel.status]}
				</Badge>
			</div>
		);
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Switching order</CardTitle>
				<CardDescription>
					Which account serves next, and why. Updates live as quotas change.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-1">
				<div className="divide-y divide-border">
					{activation.map((a) => row(a, true))}
				</div>
				{excluded.length > 0 && (
					<div className="pt-3">
						<p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Unavailable
						</p>
						<div className="divide-y divide-border opacity-70">
							{excluded.map((a) => row(a, false))}
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
