const serviceName = "BankGlass";
const jsonContentType = "application/json; charset=utf-8";

const linksetContentType =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

const apiCatalogPath = "/.well-known/api-catalog";
const oauthResourceMetadataPath = "/.well-known/oauth-protected-resource";

const discoveryPaths = new Set([
  "/llms.txt",
  apiCatalogPath,
  "/openapi.json",
  "/.well-known/mcp/server-card.json",
  oauthResourceMetadataPath,
]);

const securityHeaders = {
  "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const response = (body: BodyInit, contentType: string) =>
  new Response(body, {
    headers: { ...securityHeaders, "Content-Type": contentType },
  });

const accountIdParameter = "#/components/parameters/AccountId";
const fromParameter = "#/components/parameters/From";
const toParameter = "#/components/parameters/To";
const limitParameter = "#/components/parameters/Limit";
const cursorParameter = "#/components/parameters/Cursor";
const transactionPageDescription = "Transaction page";

const openApiDocument = (origin: string) => ({
  components: {
    parameters: {
      AccountId: {
        in: "path",
        name: "accountId",
        required: true,
        schema: { minLength: 1, type: "string" },
      },
      Cursor: {
        description: "Opaque keyset pagination cursor from the prior response.",
        in: "query",
        name: "cursor",
        schema: { type: "string" },
      },
      From: {
        description: "Inclusive ISO 8601 date-time filter.",
        in: "query",
        name: "from",
        schema: { format: "date-time", type: "string" },
      },
      Limit: {
        in: "query",
        name: "limit",
        schema: { default: 50, maximum: 200, minimum: 1, type: "integer" },
      },
      To: {
        description: "Inclusive ISO 8601 date-time filter.",
        in: "query",
        name: "to",
        schema: { format: "date-time", type: "string" },
      },
    },
    securitySchemes: {
      ApiBearerToken: {
        description: "The API_BEARER_TOKEN configured by the service owner.",
        scheme: "bearer",
        type: "http",
      },
      CloudflareAccess: {
        description:
          "A valid Cloudflare Access identity assertion. Unattended clients may use a Cloudflare Access service token at the edge.",
        in: "header",
        name: "Cf-Access-Jwt-Assertion",
        type: "apiKey",
      },
    },
  },
  info: {
    description:
      "Read-only API for cached account, balance, transaction, and synchronization data. Refresh requests ask the provider to refresh its cache; they do not modify financial records.",
    title: `${serviceName} REST API`,
    version: "1.0.0",
  },
  openapi: "3.1.0",
  paths: {
    "/accounts": {
      get: {
        operationId: "listAccounts",
        responses: { "200": { description: "Account list" } },
        summary: "List cached accounts and balances",
      },
    },
    "/accounts/{accountId}": {
      get: {
        operationId: "getAccount",
        parameters: [{ $ref: accountIdParameter }],
        responses: {
          "200": { description: "Account" },
          "404": { description: "Account not found" },
        },
        summary: "Get one account",
      },
    },
    "/accounts/{accountId}/balance": {
      get: {
        operationId: "getBalance",
        parameters: [{ $ref: "#/components/parameters/AccountId" }],
        responses: { "200": { description: "Balance" } },
        summary: "Get an account balance and freshness timestamps",
      },
    },
    "/accounts/{accountId}/pending": {
      get: {
        operationId: "listPendingTransactions",
        parameters: [
          { $ref: accountIdParameter },
          { $ref: fromParameter },
          { $ref: toParameter },
          { $ref: limitParameter },
          { $ref: cursorParameter },
        ],
        responses: { "200": { description: transactionPageDescription } },
        summary: "List pending transactions for an account",
      },
    },
    "/accounts/{accountId}/transactions": {
      get: {
        operationId: "listAccountTransactions",
        parameters: [
          { $ref: accountIdParameter },
          { $ref: fromParameter },
          { $ref: toParameter },
          { $ref: limitParameter },
          { $ref: cursorParameter },
        ],
        responses: { "200": { description: transactionPageDescription } },
        summary: "List posted transactions for an account",
      },
    },
    "/refresh": {
      post: {
        description:
          "Rate-limited. Returns 202 when the synchronization request is accepted. This endpoint does not make payments or mutate account data.",
        operationId: "requestRefresh",
        responses: {
          "202": { description: "Refresh accepted" },
          "409": { description: "Synchronization already in progress" },
          "429": { description: "Rate limited or refresh cooldown active" },
        },
        summary: "Request a provider refresh and synchronize its current cache",
      },
    },
    "/status": {
      get: {
        operationId: "getSyncStatus",
        responses: { "200": { description: "Synchronization status list" } },
        summary: "Get synchronization status for each connection",
      },
    },
    "/transactions": {
      get: {
        operationId: "listTransactions",
        parameters: [
          { $ref: fromParameter },
          { $ref: toParameter },
          { $ref: limitParameter },
          { $ref: cursorParameter },
        ],
        responses: { "200": { description: transactionPageDescription } },
        summary: "List posted transactions across accounts",
      },
    },
  },
  security: [{ ApiBearerToken: [], CloudflareAccess: [] }],
  servers: [{ url: `${origin}/api/v1` }],
});

const apiCatalog = (origin: string) => ({
  linkset: [
    {
      anchor: `${origin}/api/v1`,
      item: [
        { href: `${origin}/api/v1/accounts` },
        { href: `${origin}/api/v1/transactions` },
        { href: `${origin}/api/v1/status` },
        { href: `${origin}/api/v1/refresh` },
        { href: `${origin}/mcp` },
      ],
      "service-desc": [
        {
          href: `${origin}/openapi.json`,
          type: "application/vnd.oai.openapi+json",
        },
      ],
      "service-doc": [{ href: `${origin}/llms.txt`, type: "text/plain" }],
    },
  ],
});

const mcpServerCard = (origin: string) => ({
  $schema:
    "https://static.modelcontextprotocol.io/schemas/2025-09-16/server.schema.json",
  authentication: {
    documentation: `${origin}/llms.txt`,
    required: true,
    schemes: [
      "Cloudflare Access Managed OAuth",
      "Cloudflare Access service token",
    ],
  },
  description:
    "Read-only MCP tools for cached account balances, transactions, and synchronization status.",
  remotes: [{ type: "streamable-http", url: `${origin}/mcp` }],
  serverInfo: { name: "bankglass", title: "BankGlass", version: "1.0.0" },
  version: "1.0.0",
});

const protectedResourceMetadata = (
  origin: string,
  accessTeamDomain: string
) => ({
  authorization_servers: [accessTeamDomain],
  bearer_methods_supported: ["header"],
  resource: `${origin}/mcp`,
  resource_documentation: `${origin}/llms.txt`,
  resource_name: serviceName,
});

const llmsText = (origin: string) => `# BankGlass

BankGlass is a self-hosted, single-user, read-only API and Model Context Protocol (MCP) server for financial accounts connected through the configured provider. It periodically caches account, balance, and transaction data in a Cloudflare Durable Object.

## Security and scope

- All discovery documents are public. REST and MCP requests remain protected by Cloudflare Access; REST additionally requires an API bearer token.
- The service is not multi-user, is not affiliated with a financial institution, and cannot make payments or modify accounts.
- Data is served from a local cache. A successful sync does not guarantee that the upstream institution supplied new data.
- Never include credentials in URLs or send the REST bearer token to the MCP endpoint.

## Interfaces

- REST base URL: ${origin}/api/v1
- OpenAPI 3.1 document: ${origin}/openapi.json
- MCP Streamable HTTP endpoint: ${origin}/mcp
- MCP tools: list_accounts, get_balance, list_transactions, get_sync_status
- REST endpoints: GET /accounts, GET /accounts/{accountId}, GET /accounts/{accountId}/balance, GET /accounts/{accountId}/transactions, GET /accounts/{accountId}/pending, GET /transactions, GET /status, POST /refresh
- Transaction filters: from, to, limit (1–200; defaults to 50), and cursor. Dates are ISO 8601 date-times; pagination is newest-first keyset pagination.

## Authentication

Every REST request requires a valid Cloudflare Access identity and Authorization: Bearer <API_BEARER_TOKEN>. MCP uses Cloudflare Access Managed OAuth for interactive clients or a Cloudflare Access service token for unattended clients; MCP does not accept the REST bearer token.

## Discovery

- API catalog: ${origin}/.well-known/api-catalog
- MCP server card: ${origin}/.well-known/mcp/server-card.json
- OAuth protected-resource metadata: ${origin}/.well-known/oauth-protected-resource

## Documentation

- Project README: https://github.com/mynameistito/bankglass#readme
- License: MIT
`;

const isDiscoveryPath = (pathname: string) => discoveryPaths.has(pathname);

/**
 * Serve public machine-readable service metadata without invoking data routes.
 *
 * @param request - HTTP request for a discovery document.
 * @param accessTeamDomain - Cloudflare Access authorization server URL.
 * @returns The discovery response, or `null` when the path is not a document.
 */
export const routeDiscoveryRequest = (
  request: Request,
  accessTeamDomain: string
) => {
  const url = new URL(request.url);

  if (!isDiscoveryPath(url.pathname)) {
    return null;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      headers: { Allow: "GET, HEAD" },
      status: 405,
    });
  }

  const { origin } = url;
  let result: Response;

  switch (url.pathname) {
    case "/llms.txt": {
      result = response(llmsText(origin), "text/plain; charset=utf-8");
      break;
    }

    case apiCatalogPath: {
      result = response(JSON.stringify(apiCatalog(origin)), linksetContentType);
      break;
    }

    case "/openapi.json": {
      result = response(
        JSON.stringify(openApiDocument(origin)),
        "application/vnd.oai.openapi+json;version=3.1; charset=utf-8"
      );
      break;
    }

    case "/.well-known/mcp/server-card.json": {
      result = response(JSON.stringify(mcpServerCard(origin)), jsonContentType);
      break;
    }

    case oauthResourceMetadataPath: {
      result = response(
        JSON.stringify(protectedResourceMetadata(origin, accessTeamDomain)),
        jsonContentType
      );
      break;
    }

    default: {
      return null;
    }
  }

  if (request.method === "HEAD") {
    const headers = new Headers(result.headers);

    if (url.pathname === apiCatalogPath) {
      headers.set("Link", `<${url.href}>; rel="api-catalog"`);
    }

    return new Response(null, {
      headers,
      status: result.status,
    });
  }

  return result;
};
