# BankGlass

A self-hosted, read-only banking API and MCP server for securely connecting applications and AI agents to personal financial data. BankGlass runs entirely on Cloudflare Workers, stores normalized account and transaction history in D1, and uses Effect for services, layers, schemas, typed errors, retries, timeouts, orchestration, logging, and tests.

This is deliberately not a multi-user product. It has no signup, tenant, payment, or arbitrary upstream-proxy functionality.

## Provider decision

Research was checked against primary sources on 26 August 2026. **Akahu Personal Apps** are the best fit: they are explicitly free for one user accessing their own data, support official BNZ open-banking connections, and expose accounts, balances, posted transactions, pending transactions where BNZ supplies them, and transaction enrichment.

| Option | Personal access | Cost | BNZ data | Freshness and events | Decision |
| --- | --- | --- | --- | --- | --- |
| Akahu Personal App | Explicitly limited to the owner's Akahu account | Free | Accounts, balances, posted and pending transaction endpoints | Cached; daily scheduled refresh; one-hour manual rest period; no webhooks | **Selected** |
| Akahu full app | Intended for production apps and multiple users; Akahu accreditation required | Typically NZ$0.50-NZ$2.50/user/month, quote-based | Same normalized account and transaction APIs | Custom scheduled cadence; default 15-minute manual rest period; webhooks | Upgrade only if faster refresh/webhooks become worth paying for |
| Direct BNZ CDR | Production API is for accredited requestors, not casual personal scripts | Bank calls cannot be charged, but MBIE accreditation starts at NZ$1,500 plus renewal, levy, certificates, insurance, and compliance | Official account information APIs include balances and transaction statuses | Direct request-time API; no public exact cache/rate SLA; v3 events cover consent status, not transaction changes | Disproportionate for one user |
| Blink Data Services | Business production onboarding | NZ$99/month minimum plus data charges and term | BNZ accounts, balances, transactions | Marketed as real-time; public pending/cache/transaction-webhook details are incomplete | Too expensive |
| Fiskil | Commercial fintech/business service; no personal tier documented | Quote only | BNZ accounts, balances, transactions | Marketed as real-time; detailed public pending/cache limits unavailable | No personal advantage over Akahu |
| PocketSmith/Xero feeds | Consumer/accounting product, not a raw personal bank API | Product subscription | BNZ feeds | Roughly 12-24 hours in PocketSmith/Xero | Wrong interface |

Important primary sources:

- [Akahu Personal Apps](https://developers.akahu.nz/docs/personal-apps): free, one user, daily scheduled refresh, one-hour manual rest period, no webhooks.
- [Akahu pricing](https://www.akahu.nz/pricing): own-data Personal App access is free; full ongoing connectivity is typically NZ$0.50-NZ$2.50/user/month.
- [Akahu supported integrations](https://developers.akahu.nz/docs/integrations): BNZ account and transaction data are supported.
- [Akahu official-open-banking FAQ](https://developers.akahu.nz/docs/official-open-banking-faqs): Personal Apps can use official connections.
- [Akahu data refreshes](https://developers.akahu.nz/docs/data-refreshes): reads return cached data; refreshes are asynchronous and may be ignored inside the rest period.
- [Akahu transaction guide](https://developers.akahu.nz/docs/accessing-transactional-data): posted and pending use separate endpoints; Personal Apps receive 365 days of initial history; pending rows have no stable upstream ID.
- [BNZ open banking](https://www.bnz.co.nz/open-banking): only trusted, due-diligenced third parties receive API access.
- [BNZ developer portal](https://developer.bnz.co.nz/default): production open-banking APIs are for accredited requestors; proprietary direct access is aimed at BNZ Business customers.
- [MBIE CDR accreditation](https://www.mbie.govt.nz/business-and-employment/business/consumer-data-right/participating-as-a-data-holder-or-accredited-requestor/accredited-requestors) and [fees](https://www.mbie.govt.nz/business-and-employment/business/consumer-data-right/participating-as-a-data-holder-or-accredited-requestor/fees-and-levies-for-consumer-data-right).
- [Payments NZ Account Information standard](https://paymentsnz.atlassian.net/wiki/spaces/PaymentsNZAPIStandards/pages/1909358829/Account+Information+API+Specification+v2.2.3) and [Event Notification standard](https://www.apicentre.paymentsnz.co.nz/standards/available-standards/event-notification-api-standard).

No legitimate free individual option provides guaranteed near-real-time BNZ data or transaction webhooks. Polling this API every minute does not make the underlying data newer.

## Architecture

```text
BNZ official Open Banking / CDR
              |
              v
   Akahu Personal App cache
              |
              v
Cloudflare Worker + Effect
  |-- Access-protected HTTP API
  |-- read-only MCP endpoint
  |-- AkahuBankProvider Layer
  |-- SyncService Layer
  |-- D1BankStore Layer
  |-- daily Cron Trigger
  `-- Worker secrets
              |
              v
             D1
```

No Durable Object is used. D1's conditional `sync_state` update is enough to serialize a single user's syncs. No KV is used because no eventually consistent cache is needed. Reads use D1 and do not call Akahu.

`BankProvider` owns the normalized provider contract. `AkahuBankProvider` decodes Akahu JSON with Effect Schema and converts it at the boundary. Provider types never enter D1 or API contracts. `BankStore` owns persistence. `SyncService` owns refresh cooldown, retrieval order, reconciliation, and status transitions.

## Freshness semantics

These timestamps are intentionally different:

- `dataUpdatedAt`: when this application last observed and normalized this specific record. It does not mean BNZ changed at that instant.
- `providerRefreshedAt`: Akahu's account `refreshed` timestamp, meaning Akahu's view was retrieved/processed from the data holder as of that instant. Global status uses the oldest available balance/transaction refresh across accounts, providing a conservative whole-dataset timestamp.
- `syncedAt`: when the normalized snapshot was committed to D1.
- `lastProviderRefreshRequestedAt`: when this Worker asked Akahu to refresh. It is never presented as proof that BNZ data changed or was fetched.
- `lastSuccessAt`: when the complete provider-to-D1 synchronization succeeded.

`POST /v1/refresh` asks Akahu to refresh, waits briefly for asynchronous processing, then synchronizes the currently available Akahu cache. The response and `/v1/status` expose actual provider timestamps, which can remain unchanged. Personal App requests are rejected locally for one hour after the previous request. A daily Cron at 03:17 UTC performs the same process.

Posted rows use stable Akahu transaction IDs and are upserted. Each sync reconciles the configurable recent lookback window so upstream edits/deletions are reflected while older local history remains retained. Pending rows have no Akahu ID, so a deterministic local fingerprint is generated and the complete pending set is replaced every sync. A settled row is inserted while its old pending representation disappears.

## Access wall and agent access

The custom hostname must be covered by one Cloudflare Access self-hosted application. Access is the outer authorization boundary for every route, and the Worker independently verifies the signed `Cf-Access-Jwt-Assertion` against the configured team-domain JWKS, issuer, and application audience before reading D1.

Create two Access policies on that application:

- An `Allow` policy restricted to the owner's exact IdP email for browser and interactive agent access.
- A `Service Auth` policy restricted to a dedicated Access service token for unattended agents.

Enable **Managed OAuth** on the application for interactive MCP clients. Use a 5-15 minute access-token lifetime and a grant session appropriate for the device. Enable only the localhost, loopback, or exact HTTPS redirect URIs required by the chosen clients. Access service tokens are the machine credential for autonomous agents; send their generated `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Never put the service-token secret in Wrangler because Access consumes it before the request reaches the Worker.

Disable the public `workers.dev` route after the custom hostname and Access application work. Otherwise that hostname could bypass the Access wall, although the Worker's JWT validation still fails closed.

## API

All routes first require Cloudflare Access. REST routes additionally require `Authorization: Bearer <API_BEARER_TOKEN>` as defense in depth.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/accounts` | All locally stored accounts |
| `GET` | `/v1/accounts/:accountId` | One account |
| `GET` | `/v1/accounts/:accountId/balance` | Current/available balance and freshness |
| `GET` | `/v1/accounts/:accountId/transactions` | Posted transactions |
| `GET` | `/v1/accounts/:accountId/pending` | Pending transactions |
| `GET` | `/v1/transactions` | Posted transactions across accounts |
| `POST` | `/v1/refresh` | Request upstream refresh and synchronize |
| `GET` | `/v1/status` | Refresh/sync status and timestamps |

Transaction routes accept `from`, `to`, `limit` (1-200, default 50), and opaque `cursor`. Dates are ISO 8601. Results sort newest first with stable keyset pagination.

```text
curl "https://domain.tld/v1/accounts" --header "Authorization: Bearer <API_BEARER_TOKEN>" --header "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" --header "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>"
curl "https://domain.tld/v1/transactions?from=2026-08-01T00:00:00Z&limit=50" --header "Authorization: Bearer <API_BEARER_TOKEN>" --header "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" --header "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>"
curl --request POST "https://domain.tld/v1/refresh" --header "Authorization: Bearer <API_BEARER_TOKEN>" --header "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" --header "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>"
```

Replace the placeholders with values from your secret manager or environment. In PowerShell, use `curl.exe` if `curl` resolves to the legacy `Invoke-WebRequest` alias. An unattended REST client supplies all three headers: the REST bearer plus `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

## MCP

The stateless Streamable HTTP endpoint is `https://domain.tld/mcp`. It deliberately does not use the REST bearer because Managed OAuth owns `Authorization`; Cloudflare Access authentication remains mandatory. It exposes four read-only tools:

| Tool | Description |
| --- | --- |
| `list_accounts` | Cached accounts and balances |
| `get_balance` | One balance and freshness timestamps |
| `list_transactions` | Posted or pending transactions with filters and cursor pagination |
| `get_sync_status` | Sync state and provider freshness |

Tool inputs:

| Tool | Inputs |
| --- | --- |
| `list_accounts` | None |
| `get_balance` | Required `accountId` |
| `list_transactions` | Optional `accountId`, `cursor`, `from`, `to`; `status` is `posted` or `pending` and defaults to `posted`; `limit` is 1-200 and defaults to 50 |
| `get_sync_status` | None |

There is no MCP refresh or payment tool. An agent cannot cause upstream provider activity or mutate banking data.

### Connect An MCP Client

Interactive MCP clients that support remote OAuth can use this server definition. The client will open the Cloudflare Access login flow:

```json
{
  "mcpServers": {
    "bankglass": {
      "url": "https://domain.tld/mcp"
    }
  }
}
```

For an unattended client that supports custom transport headers, configure a Cloudflare Access service token. The MCP endpoint does not use `API_BEARER_TOKEN`:

```json
{
  "mcpServers": {
    "bankglass": {
      "url": "https://domain.tld/mcp",
      "headers": {
        "CF-Access-Client-Id": "${CF_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${CF_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the MCP client's private environment or secret manager. Do not add the REST `Authorization` header to this configuration: MCP Managed OAuth owns that header, and the REST bearer is only accepted by `/v1/*` routes.

Errors are stable envelopes such as:

```json
{
  "error": {
    "code": "REFRESH_COOLDOWN",
    "message": "Request could not be completed"
  },
  "retryAt": "2026-08-26T04:17:00.000Z"
}
```

## Akahu setup

1. Create an Akahu profile at [my.akahu.nz](https://my.akahu.nz), complete identity verification and MFA, and create a Personal App.
2. Connect BNZ using the official open-banking connection. Authentication and account consent occur with BNZ; this project never receives or stores BNZ credentials.
3. On Akahu's Developers page, obtain the App ID Token and User Access Token.
4. Limit the Personal App's permissions to read-only account and transaction access. Personal Apps cannot initiate payments.
5. Rotate either token immediately if it may have been exposed.

Cloudflare Workers do not have a fixed outbound IP, so Akahu Personal App IP allow-listing is not generally usable without extra network infrastructure. This project intentionally does not add that infrastructure.

## Local development

Requirements: [Bun](https://bun.sh/) and a Cloudflare account. A local D1 database is enough for tests and development; no BNZ or Akahu account is required to run the test suite.

```powershell
bun install
Copy-Item .dev.vars.example .dev.vars
bunx wrangler d1 migrations apply bankglass --local
bun run dev
```

The Worker intentionally fails closed without a valid Access assertion. Use the automated tests for local boundary testing; use the Access-protected custom hostname for interactive end-to-end calls. Do not add a local authentication bypass.

Create `.dev.vars` locally with the following values. These are local development secrets and must not be committed:

```dotenv
AKAHU_APP_TOKEN=replace-me
AKAHU_USER_TOKEN=replace-me
API_BEARER_TOKEN=replace-with-at-least-32-random-bytes
ACCESS_APP_HOSTNAME=domain.tld
ACCESS_POLICY_AUD=replace-with-access-application-aud
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
```

`.dev.vars` is ignored by Git. Do not use real credentials in tests; tests use deterministic providers and Miniflare bindings.

Generate a bearer token with PowerShell instead of storing a literal token in shell history:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

## Cloudflare deployment

1. Authenticate: `bunx wrangler login`.
2. Create D1 if it does not already exist: `bunx wrangler d1 create bankglass`.
3. Put the returned database ID in `wrangler.jsonc` as `d1_databases[0].database_id`.
4. Choose the intended custom hostname and create a Cloudflare Access self-hosted application covering it. Add the owner-email `Allow` policy and agent `Service Auth` policy, and enable Managed OAuth.
5. Set `ACCESS_APP_HOSTNAME` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc` for the custom hostname and team domain. The Access application's **Application audience (AUD) tag** belongs in a secret, not in `wrangler.jsonc`.
6. Apply migrations: `bunx wrangler d1 migrations apply bankglass --remote`.
7. Add or replace the Worker secrets interactively:

```powershell
bunx wrangler secret put AKAHU_APP_TOKEN
bunx wrangler secret put AKAHU_USER_TOKEN
bunx wrangler secret put API_BEARER_TOKEN
bunx wrangler secret put ACCESS_POLICY_AUD
```

When prompted, enter the value for each secret. For `ACCESS_POLICY_AUD`, use the **Application audience (AUD) tag** from the Cloudflare Access self-hosted application. Running the same command later replaces the existing secret, for example after creating a new Access application or rotating the API bearer token. Do not put Akahu tokens, the API bearer, or the Access AUD in `wrangler.jsonc`, source control, or command-line arguments.

8. Run verification: `bun run typecheck`, `bun run test`, and `bun run lint`.
9. Deploy: `bun run deploy`.
10. Attach the Worker custom domain, validate browser, Managed OAuth, and service-token access, then disable the public `workers.dev` route.
11. Call `POST /v1/refresh` once to seed D1.

Non-secret settings are in `wrangler.jsonc`: one-hour cooldown, 14-day reconciliation window, 60 authenticated requests/minute, and daily Cron. `worker-configuration.d.ts` is generated by `wrangler types`.

## Security and threat model

Protected assets are API data, D1 history, the API bearer token, and Akahu tokens. Expected attackers include internet scanners, a leaked API client token, a compromised source repository, and accidental sensitive logging. Cloudflare account compromise and compromise of the owner's endpoint device remain privileged threats outside application-only controls.

Controls:

- Every endpoint, including status, authenticates before reading D1.
- Every request requires a valid Cloudflare Access JWT with the expected signature, issuer, and application audience. Access signing keys are retrieved from the rotating team JWKS.
- REST retains an independent bearer; MCP is read-only and omits it to remain compatible with Managed OAuth.
- Bearer values are SHA-256 hashed and compared across every byte without early exit.
- API and provider credentials exist only as Worker secrets/bindings.
- Provider errors are classified without logging response bodies, tokens, account details, or transactions.
- Query values are strictly bounded; there is no arbitrary SQL, URL, or upstream proxy input.
- A D1 fixed-window limiter bounds authenticated traffic to 60 requests/minute.
- REST responses use `no-store`, HSTS, CSP, frame denial, MIME sniffing prevention, and referrer suppression. MCP responses use `no-store` and MIME sniffing prevention while preserving protocol transport headers.
- The provider implementation is read-only. No payment scope or payment route exists.
- D1 stores useful normalized account, balance, and transaction fields, not BNZ credentials, Akahu tokens, party addresses, raw provider responses, or full card numbers.
- Sync locking prevents concurrent refresh work; unique constraints and reconciliation make retries idempotent.
- Cloudflare observability is enabled, but logs contain operation/error tags only.

Use a random API token of at least 32 bytes, keep Cloudflare MFA enabled, restrict Cloudflare account membership, and rotate API, Akahu, and Access service-token credentials after suspected exposure.

## Tests and quality

```powershell
bun run typecheck
bun run test
bun run lint
bun run format
```

Vitest runs inside workerd with a real local D1 binding. Coverage includes Access JWT signature/issuer/audience validation, MCP initialization, provider decoding/normalization, invalid responses, provider rate limits and retries, constant-work bearer authentication, D1 idempotency, duplicate handling, pending-to-settled replacement, keyset pagination, API rate limits/errors/security headers, cooldown policy, and the Cloudflare HTTP/D1 boundary. No test needs a BNZ or Akahu account.

Ultracite uses Oxlint and Oxfmt. One documented lint exception disables an async/await preference that is structurally incompatible with Effect's typed callback combinators; all safety and correctness rules remain enabled.

## Adding another provider

Implement the domain-shaped `BankProviderService` in `src/bank-provider.ts`, decode the provider protocol with Effect Schema in a new adapter, normalize to `BankAccount`, `PostedTransaction`, and `PendingTransaction`, and provide its Layer in `src/index.ts`. D1, synchronization, HTTP routes, authentication, and tests do not need provider-specific changes. The implementation must preserve provider freshness timestamps and explicitly document pending-ID and refresh semantics.
