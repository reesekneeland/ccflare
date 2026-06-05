import { Logger } from "@ccflare/logger";
import type {
	ProxyContext,
	ResolvedProxyContext,
} from "./handlers/proxy-types";
import { getValidAccessToken } from "./handlers/token-manager";

const log = new Logger("UsagePoller");

const DEFAULT_POLL_MS = 60_000;
const POLL_ENV = "CF_USAGE_POLL_MS";

function resolvePollInterval(): number {
	const raw = process.env[POLL_ENV];
	if (raw === undefined || raw === "") return DEFAULT_POLL_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_POLL_MS;
}

/**
 * Refresh every account's quota utilization from its provider's zero-cost usage
 * endpoint and persist it, so the dashboard and the burn-down strategy have
 * cross-account data even for accounts not currently serving traffic. Only
 * providers that implement `fetchUsage` (claude-code) are polled; others skip.
 */
async function pollOnce(ctx: ProxyContext): Promise<void> {
	// Skip paused accounts: polling them would trigger token refreshes (and
	// failure backoff) for seats that aren't serving traffic.
	const accounts = ctx.dbOps.getAllAccounts().filter((a) => !a.paused);
	for (const account of accounts) {
		const provider = ctx.providerRegistry.getProvider(account.provider);
		if (!provider?.fetchUsage) continue;
		try {
			const resolved: ResolvedProxyContext = {
				...ctx,
				provider,
				providerName: account.provider,
				upstreamPath: "",
			};
			const token = await getValidAccessToken(account, resolved);
			if (!token) continue; // api-key accounts have no usage endpoint
			const util = await provider.fetchUsage(token);
			if (util) {
				// Serialize through the async writer like every other DB write on
				// the proxy path, so poller and request writes never race.
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateAccountUtilization(account.id, util),
				);
			}
		} catch (err) {
			// One account's failure (e.g. refresh backoff) must not stop the rest.
			log.warn(`Usage poll failed for account ${account.name}: ${err}`);
		}
	}
}

/**
 * Start the periodic usage poller. Returns a stopper. Disabled (no-op) when
 * `CF_USAGE_POLL_MS=0`. Runs once immediately so the dashboard populates without
 * waiting a full interval.
 */
export function startUsagePoller(ctx: ProxyContext): () => void {
	const intervalMs = resolvePollInterval();
	if (intervalMs === 0) {
		log.info("Usage poller disabled (CF_USAGE_POLL_MS=0)");
		return () => {};
	}
	log.info(`Usage poller started (every ${intervalMs}ms)`);

	void pollOnce(ctx).catch((err) =>
		log.warn(`Initial usage poll failed: ${err}`),
	);
	const timer = setInterval(() => {
		void pollOnce(ctx).catch((err) => log.warn(`Usage poll failed: ${err}`));
	}, intervalMs);
	// Don't keep the event loop alive solely for polling.
	timer.unref?.();

	return () => clearInterval(timer);
}
