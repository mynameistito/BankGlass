# BankGlass

BankGlass is a self-hosted, read-only API and [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for the accounts connected to one [Akahu Personal App](https://developers.akahu.nz/docs/personal-apps).

It periodically copies account, balance, and transaction data from Akahu into a Cloudflare Durable Object, then makes the cached data available to trusted applications and AI agents. It cannot make payments or modify bank accounts.

> [!IMPORTANT] BankGlass is a personal, single-user service. It is not a multi-user banking product and is not affiliated with Akahu or any financial institution.

## What It Does

- Reads every account connected to the configured Akahu Personal App, across the institutions Akahu supports.
- Stores normalized accounts, balances, posted transactions, and pending transactions in a Cloudflare Durable Object SQLite store.
- Exposes a REST API protected by Cloudflare Access and a separate bearer token.
- Exposes four read-only MCP tools protected by Cloudflare Access.
- Refreshes automatically once a day and supports a rate-limited manual refresh.
- Keeps reads fast and private by serving them from the Durable Object instead of calling Akahu on every request.

BankGlass deliberately has no signup flow, tenants, payment scopes, payment endpoints, or arbitrary upstream proxy.

## Architecture

```text
Connected financial institutions
              |
              v
     Akahu Personal App
              |
              v
  Cloudflare Worker + Effect
      |              |
      v              v
  REST API        MCP server
      \              /
       v            v
        Cloudflare Durable Object
```

[Alchemy](https://alchemy.run/) provisions the Worker, Durable Object, custom domain, scheduled job, and observability. [Effect](https://effect.website/) provides the service architecture, schemas, retries, timeouts, typed errors, and orchestration.

## Requirements

- [Bun 1.4.0](https://bun.sh/)
- A Cloudflare account with a domain managed by Cloudflare
- A Cloudflare Access team
- An [Akahu Personal App](https://developers.akahu.nz/docs/personal-apps) with read-only account and transaction permissions

Akahu Personal Apps are intended for one person accessing their own data. Akahu controls institution support, data freshness, and refresh limits; see the [Personal Apps](https://developers.akahu.nz/docs/personal-apps), [supported integrations](https://developers.akahu.nz/docs/integrations), and [data refreshes](https://developers.akahu.nz/docs/data-refreshes) documentation.

## Set Up Akahu

1. Create an Akahu profile at [my.akahu.nz](https://my.akahu.nz), enable MFA, and create a Personal App.
2. Connect the financial institutions and accounts you want BankGlass to read.
3. Grant only the account and transaction read permissions BankGlass needs.
4. Copy the App ID Token and User Access Token from Akahu's developer page.

Bank authentication and consent happen between you, Akahu, and the institution. BankGlass never receives online-banking credentials.

## Configure Cloudflare Access

Create a Cloudflare Access self-hosted application for the hostname where BankGlass will run. Every route must pass through this Access application.

Recommended policies:

- An `Allow` policy for your exact identity-provider email, used by browsers and interactive MCP clients.
- A `Service Auth` policy for a dedicated Access service token, used by unattended clients.

Enable Managed OAuth if interactive MCP clients will connect to the server. Allow only the redirect URIs those clients require.

BankGlass also verifies the Access JWT inside the Worker, including its signature, issuer, and application audience. Once the custom hostname works, keep the production `workers.dev` route disabled so requests cannot bypass the Access application.

## Local Development

Install dependencies and create a local configuration file:

```powershell
bun install
Copy-Item .dev.vars.example .dev.vars
```

Fill in `.dev.vars`:

```dotenv
AKAHU_APP_TOKEN=replace-me
AKAHU_USER_TOKEN=replace-me
API_BEARER_TOKEN=replace-with-a-random-32-byte-token
ACCESS_APP_HOSTNAME=bank.example.com
ACCESS_POLICY_AUD=replace-with-access-application-aud
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
AKAHU_API_BASE_URL=https://api.akahu.io/v1
REFRESH_COOLDOWN_SECONDS=3600
SYNC_LOOKBACK_DAYS=14
API_RATE_LIMIT_PER_MINUTE=60
```

Generate the REST bearer token in PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

Start the local Worker:

```powershell
bun run dev
```

Alchemy receives `.dev.vars` through the `dev` script. The Worker intentionally has no local authentication bypass, so use the test suite for local boundary testing and an Access-protected deployment for end-to-end requests.

`.dev.vars`, `.env`, local Durable Object data, Alchemy state, and Wrangler state are ignored by Git. Never commit real credentials.

## Deploy

BankGlass includes an Alchemy deployment and a GitHub Actions workflow. Before deploying a fork, replace the repository owner's production hostname in `alchemy.run.ts` and `.github/workflows/deploy.yml` with your own Access-protected hostname.

Set these secrets in your environment or GitHub repository:

| Secret                  | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| `AKAHU_APP_TOKEN`       | Akahu Personal App ID token                  |
| `AKAHU_USER_TOKEN`      | Akahu user access token                      |
| `API_BEARER_TOKEN`      | Additional authentication for `/v1/*` routes |
| `ACCESS_POLICY_AUD`     | Audience tag of the Access application       |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account used for deployment       |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare deployment credential             |

Set these non-secret values:

| Variable | Example | Default |
| --- | --- | --- |
| `ACCESS_APP_HOSTNAME` | `bank.example.com` | Required |
| `ACCESS_TEAM_DOMAIN` | `https://example.cloudflareaccess.com` | Required |
| `AKAHU_API_BASE_URL` | `https://api.akahu.io/v1` | Shown value |
| `API_RATE_LIMIT_PER_MINUTE` | `60` | `60` |
| `REFRESH_COOLDOWN_SECONDS` | `3600` | `3600` |
| `SYNC_LOOKBACK_DAYS` | `14` | `14` |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | Your Workers subdomain | Required for PR previews |

For a local production deployment, load the values into the environment and run:

```powershell
$env:STAGE = "prod"
bun run deploy
```

The included deployment workflow deploys `main` after CI succeeds and creates previews for same-repository pull requests. After the first deployment:

1. Confirm the custom hostname is covered by Cloudflare Access.
2. Test interactive and service-token authentication.
3. Call `POST /v1/refresh` once to seed the Durable Object.
4. Confirm `GET /v1/status` reports a successful sync.

## REST API

Every REST request needs both a valid Cloudflare Access identity and `Authorization: Bearer <API_BEARER_TOKEN>`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/accounts` | List cached accounts and balances |
| `GET` | `/v1/accounts/:accountId` | Get one account |
| `GET` | `/v1/accounts/:accountId/balance` | Get one balance and its freshness timestamps |
| `GET` | `/v1/accounts/:accountId/transactions` | List posted transactions for one account |
| `GET` | `/v1/accounts/:accountId/pending` | List pending transactions for one account |
| `GET` | `/v1/transactions` | List posted transactions across all accounts |
| `GET` | `/v1/status` | Get refresh and synchronization status |
| `POST` | `/v1/refresh` | Ask Akahu to refresh, then synchronize its current cache |

Transaction routes accept `from`, `to`, `limit`, and `cursor`. Dates must be ISO 8601 date-times. `limit` defaults to 50 and may be 1-200. Results use newest-first keyset pagination.

Example for an unattended client:

```sh
curl "https://bank.example.com/v1/accounts" \
  --header "Authorization: Bearer <API_BEARER_TOKEN>" \
  --header "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" \
  --header "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>"
```

An importable request collection is available at `insomnia/BankGlass.insomnia.json`.

## MCP Server

The stateless Streamable HTTP endpoint is `https://bank.example.com/mcp`. It provides four read-only tools:

| Tool | Description |
| --- | --- |
| `list_accounts` | List cached accounts and balances |
| `get_balance` | Get one balance and its freshness timestamps |
| `list_transactions` | List posted or pending transactions with filters and cursor pagination |
| `get_sync_status` | Get synchronization state and Akahu freshness |

There is no refresh or payment tool, so an MCP client cannot trigger upstream activity or mutate financial data.

Interactive clients that support remote OAuth can use:

```json
{
  "mcpServers": {
    "bankglass": {
      "url": "https://bank.example.com/mcp"
    }
  }
}
```

For an unattended client that supports custom transport headers, use a Cloudflare Access service token:

```json
{
  "mcpServers": {
    "bankglass": {
      "url": "https://bank.example.com/mcp",
      "headers": {
        "CF-Access-Client-Id": "${CF_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${CF_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

Do not send `API_BEARER_TOKEN` to `/mcp`. Managed OAuth uses the `Authorization` header, while the extra REST bearer applies only to `/v1/*`.

## Data Freshness

Akahu reads are cached, and refresh requests are asynchronous. A successful BankGlass sync means the current Akahu cache was stored in the Durable Object; it does not guarantee that an institution supplied newer data.

- `dataUpdatedAt`: when BankGlass normalized the record.
- `providerRefreshedAt`: Akahu's reported account-data freshness.
- `syncedAt`: when BankGlass committed the snapshot to the Durable Object.
- `lastProviderRefreshRequestedAt`: when BankGlass asked Akahu to refresh.
- `lastSuccessAt`: when the complete Akahu-to-cache sync last succeeded.

The default schedule runs daily at 03:17 UTC. Manual refreshes have a one-hour cooldown to match the Akahu Personal App refresh policy. Posted transactions are reconciled across the latest 14 days by default, with a safety limit of 750 transactions or 100 provider pages per sync. Pending transactions are replaced on each sync because Akahu does not provide stable IDs for them.

## Security Model

- Cloudflare Access protects every route, and the Worker independently validates Access JWTs.
- REST routes require a second bearer token.
- MCP tools and Akahu permissions are read-only; there are no payment operations.
- Akahu and API credentials are Worker secrets, not database records.
- REST data responses are not cached and include restrictive security headers.
- Input limits, Durable Object-backed rate limiting, sync locking, and idempotent reconciliation reduce abuse and consistency risks.
- Logs contain operation and error tags, not provider responses, account data, transactions, or credentials.

This does not protect against compromise of your Cloudflare account, Akahu account, client device, or secret manager. Enable MFA, restrict account membership, and rotate credentials after suspected exposure.

## Development

```powershell
bun run typecheck
bun run test
bun run check
```

Tests run in workerd against local Worker bindings and do not require an Akahu account. They cover Access JWT validation, REST and MCP boundaries, provider decoding and retry behavior, synchronization, persistence, pagination, rate limits, cooldowns, and security headers.

## License

[MIT](LICENSE)
