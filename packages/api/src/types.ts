import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import type {
	AccountProvider,
	AuthMethod,
	LoadBalancingStrategy,
	RuntimeHealth,
	SelectionOrderEntry,
} from "@ccflare/types";

// Re-exported so dashboard/TUI consumers of AccountResponse can type the
// selection field without importing @ccflare/types directly.
export type { SelectionOrderEntry, SelectionStatus } from "@ccflare/types";

export interface AccountResponse {
	id: string;
	name: string;
	provider: AccountProvider;
	auth_method: AuthMethod;
	base_url: string | null;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	weight: number;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	tokenExpiresAt: string | null;
	rateLimitStatus: {
		code: string;
		isLimited: boolean;
		until: string | null;
	};
	rateLimitReset: string | null;
	rateLimitRemaining: number | null;
	// Window-specific quota telemetry (Anthropic). Utilization is a 0..1 fraction;
	// resets are ISO strings. Null until the account has served a request.
	utilization5h: number | null;
	reset5h: string | null;
	status5h: string | null;
	utilization7d: number | null;
	reset7d: string | null;
	status7d: string | null;
	overageStatus: string | null;
	sessionInfo: {
		active: boolean;
		startedAt: string | null;
		requestCount: number;
	};
	// The account's place in the strategy's activation order (rank + reason).
	// Null when the strategy can't provide an ordering (e.g. unavailable).
	selection: SelectionOrderEntry | null;
}

export interface APIContext {
	config: Config;
	dbOps: DatabaseOperations;
	getProviders: () => string[];
	getRuntimeHealth?: () => RuntimeHealth;
	// Live load-balancing strategy, for read-only selection-order previews on the
	// accounts endpoint. Optional so the router stays usable without it.
	getStrategy?: () => LoadBalancingStrategy;
}
