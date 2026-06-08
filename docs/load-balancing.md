# Load Balancing in ccflare

## Table of Contents
1. [Overview](#overview)
2. [Session-Based Strategy](#session-based-strategy)
3. [Configuration](#configuration)
4. [Account Selection Process](#account-selection-process)
5. [Performance Considerations](#performance-considerations)
6. [Important: Why Only Session-Based Strategy](#important-why-only-session-based-strategy)

## Overview

ccflare implements a session-based load balancing system to distribute requests across multiple Claude OAuth accounts, avoiding rate limits and ensuring high availability. The system maintains configurable sessions (default: 5 hours) with individual accounts to minimize rate limit issues.

### Key Features
- **Account Health Monitoring**: Automatically filters out rate-limited or paused accounts
- **Failover Support**: Returns ordered lists of accounts for automatic failover
- **Session Persistence**: Maintains configurable sessions on specific accounts
- **Real-time Configuration**: Change settings without restarting the server
- **Provider Filtering**: Accounts are filtered by provider compatibility

## Session-Based Strategy

**Description**: Maintains sticky sessions with individual accounts for a configurable duration (default: 5 hours). This is the only load balancing strategy available in ccflare, designed to minimize account switching and reduce the likelihood of hitting rate limits.

**Use Case**: Optimal for production environments where minimizing rate limits is crucial. Particularly effective for applications with sustained user sessions.

**Implementation Details** (`packages/proxy/src/strategies/index.ts`):

`SessionStrategy` is constructed with the session duration and an optional set of
extra-usage seat names (`new SessionStrategy(sessionDurationMs, extraUsageSeats)`;
the names default to the `CCFLARE_LAST_RESORT_ACCOUNTS` env var). `select()` works in
two stages:

1. **Sticky session.** If an account holds the most recent session within the window
   and is available, it is used exclusively (returned first, others as fallback) — so a
   single account is burned down before the next is opened. The one exception is
   *last-resort preemption* (below).
2. **(Re)selection.** When no session is active (or the active one is rate-limited /
   preempted), the available accounts are ordered by `prioritize()` and the first is
   chosen for a fresh session.

**Selectability** (`isSelectable`): an account is eligible for traffic only when it is
available (not paused / not rate-limited, via `isAccountAvailable`) **and** not blocked by
an exhausted 7-day quota. A **flat-rate** seat whose 7-day utilization is at/above the cap
(`MAX_UTIL`, 0.99) is dropped from selection until its 7-day window resets — it can't serve,
so even a freshly-reset 5-hour window won't bring it back. (Extra-usage seats are exempt;
see below.) The exclusion is reset-aware: a 7-day value whose reset has passed is stale and
does not block. This gate governs both continuing a session and (re)selecting one.

**Burn-down ordering** (`prioritize` / `compareBurnDown`): among selectable **normally
balanced** accounts, order by:
- **5-hour utilization, highest first** — finish the most-burned seat before opening the
  next. A window whose reset has already passed counts as `0` (stale), and a never-seen
  account (no observed utilization) sorts last.
- **tie-break: soonest 7-day reset.**
- **final tie-break: account name**, for deterministic ordering.

**Extra-usage seats** (`CCFLARE_LAST_RESORT_ACCOUNTS`): seats with pay-per-use "extra usage"
enabled. These are **balanced like any other account while their own 5-hour quota has
headroom** (ranked by the same burn-down comparator), so their included quota is used before
any overage is billed. Once a seat's 5-hour utilization reaches the cap (`MAX_UTIL`, 0.99)
its `actsAsLastResort` flips on: it sorts **after** all normally-balanced accounts and only
serves traffic when nothing else is selectable. If such a seat is holding the active session
when it crosses the cap and any normally-balanced account is available, the session is
**preempted** onto that account so overage stops the moment normal quota exists. Extra-usage
seats are exempt from the 7-day exhaustion block — their overage lets them keep serving past
the weekly cap as the true last resort. The flip is reset-aware: when the 5-hour window
resets, the seat returns to normal balancing. (Seat identity is env-based, not derived from
the `overage_status` field, which is unreliable — the usage endpoint reports it `enabled`
for every seat.)

**Utilization data** comes from two sources, both writing the per-account 5h/7d columns:
the `anthropic-ratelimit-unified-{5h,7d}-*` headers parsed off each proxied response, and
a background **usage poller** (see [Usage polling](#usage-polling)) that refreshes every
account from a zero-cost endpoint so idle accounts still have fresh data to rank on.

## Usage polling

To rank accounts by utilization the strategy needs current 5h/7d numbers for **all**
accounts, but the response headers only refresh the account currently serving traffic. A
background poller (`packages/proxy/src/usage-poller.ts`) closes that gap: every
`CF_USAGE_POLL_MS` (default 60000ms; `0` disables) it fetches each non-paused account's
utilization from the provider's **zero-cost** account endpoint
(`ClaudeCodeProvider.fetchUsage` → `GET /api/oauth/usage` — no billed message) and persists
it. It runs once at startup so the dashboard populates immediately, reuses the proxy's
token-refresh path (dedup + backoff), and isolates per-account failures.

## Switching order (dashboard)

The Accounts page shows a **"Switching order"** panel: the live activation order and the
reason for each account's place. It is sourced from `SessionStrategy.previewSelectionOrder()`
— a **read-only twin of `select()`** that classifies every account without mutating session
state, so the display can't drift from the real selection logic (both share the
`resolveActive` / `prioritize` helpers). Each account in `GET /api/accounts` carries a
`selection { rank, status }` field; the API obtains the ordering from the live strategy via
an injected getter (no extra endpoint). Statuses: `active` (serving now), `next` (activated
next), `candidate` (in burn-down order), `last-resort` (extra-usage seat in overage),
`blocked-7d` / `rate-limited` / `paused` (excluded, rank null).

**Characteristics**:
- ✅ **Excellent Rate Limit Avoidance**: Minimizes account switching
- ✅ **Predictable Behavior**: Consistent account usage patterns
- ✅ **Good for Long Sessions**: Ideal for extended AI conversations
- ⚠️ **Uneven Load Distribution**: May concentrate load on fewer accounts
- ⚠️ **Session Dependency**: Performance tied to specific account availability

## Configuration

ccflare uses a hierarchical configuration system where environment variables take precedence over configuration file settings.

### Configuration Precedence (highest to lowest)
1. Environment variables
2. Configuration file (`~/.config/ccflare/ccflare.json`)
3. Default values

### Environment Variables

```bash
# Load balancing strategy (only 'session' is supported)
LB_STRATEGY=session

# Session duration in milliseconds (default: 18000000ms = 5 hours)
SESSION_DURATION_MS=18000000

# Comma-separated names of pay-per-use "extra usage" seats. Balanced normally
# until their own 5h quota fills, then used only as a last resort (overage).
# Default: none.
CCFLARE_LAST_RESORT_ACCOUNTS=reese

# Usage poller interval in ms (default: 60000; 0 disables). Refreshes every
# account's 5h/7d quota from the zero-cost usage endpoint.
CF_USAGE_POLL_MS=60000

# Server port (default: 8080)
PORT=8080

# Client ID for OAuth (default: 9d1c250a-e61b-44d9-88ed-5944d1962f5e)
CLIENT_ID=your-client-id

# Retry configuration
RETRY_ATTEMPTS=3
RETRY_DELAY_MS=1000
RETRY_BACKOFF=2
```

### Configuration File

The configuration file is automatically created at `~/.config/ccflare/ccflare.json` on first run (or `$XDG_CONFIG_HOME/ccflare/ccflare.json` if `XDG_CONFIG_HOME` is set):

```json
{
    "lb_strategy": "session",
    "session_duration_ms": 18000000,
    "port": 8080,
    "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    "retry_attempts": 3,
    "retry_delay_ms": 1000,
    "retry_backoff": 2
}
```

### Time Constants

The following time constants are used throughout the system:
- `SESSION_DURATION_DEFAULT`: 18000000ms (5 hours)
- `SESSION_DURATION_FALLBACK`: 3600000ms (1 hour) - used if configuration is invalid

### Dynamic Configuration

The strategy configuration can be changed at runtime via the HTTP API:

```bash
# Get current strategy
curl http://localhost:8080/api/config/strategy

# Update strategy (only 'session' is valid)
curl -X POST http://localhost:8080/api/config/strategy \
  -H "Content-Type: application/json" \
  -d '{"strategy": "session"}'

# Get all configuration settings
curl http://localhost:8080/api/config

# Get available strategies
curl http://localhost:8080/api/strategies
```

## Account Selection Process

The load balancer follows a specific process when selecting accounts for requests:

### 1. Account Filtering
```typescript
// From proxy/handlers/account-selector.ts
const providerAccounts = allAccounts.filter(
    (account) => account.provider === ctx.provider.name || account.provider === null
);
```
- Accounts are first filtered by provider compatibility
- Only accounts matching the current provider or with null provider are considered

### 2. Selectability Check
```typescript
// From core/strategy.ts
export function isAccountAvailable(account: Account, now = Date.now()): boolean {
    return (
        !account.paused &&
        (!account.rate_limited_until || account.rate_limited_until < now)
    );
}
```
The strategy gates on `isSelectable` = `isAccountAvailable && !is7dExhausted`:
- Paused accounts are excluded
- Rate-limited accounts are excluded if their rate limit hasn't expired
- Flat-rate accounts whose **7-day** utilization is at/above `MAX_UTIL` (0.99) are
  excluded until that window resets (extra-usage seats are exempt — see above)

### 3. Session Management
The SessionStrategy manages account sessions through the following process:

1. **Active Session Search**: Finds the account with the most recent active session
2. **Selectability Validation**: Checks the active account is still selectable and its
   session is within the configured duration. If it is an extra-usage seat that has
   crossed its 5h cap and a normally-balanced account is available, the session is
   **preempted**; if it is a flat-rate account whose 7-day quota filled mid-session, the
   session is **dropped** and a fresh one is forced on the replacement.
3. **Account Ordering**: Returns accounts in priority order:
   - Active session account (if still selectable) comes first
   - Other selectable accounts follow in burn-down order, extra-usage seats acting as
     last resort trailing

### 4. Session Reset
Sessions are reset when:
- No active session exists
- The current session has expired
- A new account needs to be selected

```typescript
private resetSessionIfExpired(account: Account): void {
    const now = Date.now();
    
    if (!account.session_start || 
        now - account.session_start >= this.sessionDurationMs) {
        // Reset session via StrategyStore
        this.store.resetAccountSession(account.id, now);
        account.session_start = now;
        account.session_request_count = 0;
    }
}
```

### 5. Database Updates
The StrategyStore interface provides methods for session management:
- `resetAccountSession(accountId, timestamp)`: Resets session start time and request count
- `updateAccountRequestCount(accountId, count)`: Updates request count for an account
- `getAccount(accountId)`: Retrieves account information

## Performance Considerations

### Session-Based Performance

The session strategy provides excellent rate limit avoidance at the cost of potentially uneven load distribution:

- **Rate Limit Avoidance**: By maintaining sessions with individual accounts for extended periods, the strategy minimizes the risk of hitting rate limits due to rapid account switching.
- **Load Distribution**: Load may concentrate on fewer accounts during a session window. This is acceptable for most use cases but should be monitored.
- **Failover**: If the active session account becomes unavailable, the system automatically fails over to the next available account.

### Session Storage

Session information is stored directly in the database with the following fields:
- `session_start`: Timestamp when the current session began
- `session_request_count`: Number of requests in the current session
- `rate_limited_until`: Timestamp when rate limiting expires (if applicable)

These fields are updated synchronously to ensure consistency in account selection.

### Monitoring

Monitor these key metrics:
- Account usage distribution
- Rate limit occurrences
- Session duration effectiveness
- Failover frequency

## Important: Why Only Session-Based Strategy

**⚠️ WARNING: Only the session-based load balancer strategy is available in ccflare.**

Other strategies like round-robin, least-requests, or weighted distribution have been removed from the codebase as they can trigger Claude's anti-abuse systems and result in automatic account bans. Here's why they were removed:

### Account Ban Risks

1. **Rapid Account Switching**: Strategies that frequently switch between accounts create suspicious patterns that Claude's systems detect as potential abuse.

2. **Unnatural Usage Patterns**: Round-robin and similar strategies create artificial request patterns that don't match normal human usage.

3. **Rate Limit Triggering**: Frequent account switching increases the likelihood of hitting rate limits across multiple accounts simultaneously.

### Why Session-Based is Safe

The session-based strategy mimics natural user behavior:
- Maintains consistent sessions with individual accounts
- Reduces account switching to once every 5 hours (configurable)
- Creates usage patterns similar to a regular Claude user
- Minimizes the risk of triggering anti-abuse systems

### Best Practices

1. **Always use session-based strategy**: This is the only strategy that won't risk your accounts
2. **Configure appropriate session duration**: Default 5 hours is recommended
3. **Monitor account health**: Watch for any rate limit issues or warnings
4. **Avoid custom strategies**: Do not implement custom load balancing strategies unless you fully understand the risks

If you need different behavior, adjust the session duration rather than switching strategies:
```json
{
    "lb_strategy": "session",
    "session_duration_ms": 18000000  // 5 hours (recommended)
}
```

## LoadBalancingStrategy Interface

For reference, here's the interface that all load balancing strategies must implement:

```typescript
// From types/context.ts
export interface LoadBalancingStrategy {
    /**
     * Return a filtered & ordered list of candidate accounts.
     * Accounts that are rate-limited should be filtered out.
     * The first account in the list should be tried first.
     */
    select(accounts: Account[], meta: RequestMeta): Account[];

    /**
     * Optional initialization method to inject dependencies
     * Used for strategies that need access to a StrategyStore
     */
    initialize?(store: StrategyStore): void;
}
```

The `RequestMeta` object contains:
- `id`: Unique request identifier
- `method`: HTTP method
- `path`: Request path
- `timestamp`: Request timestamp
- `agentUsed`: Optional agent identifier

Currently, only the `SessionStrategy` implementation exists in the codebase at `/packages/proxy/src/strategies/index.ts`.
