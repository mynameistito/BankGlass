import { describe, expect, it } from "vitest";

import { routeDiscoveryRequest } from "@/discovery";

const origin = "https://bank.example.test";
const accessTeamDomain = "https://team.cloudflareaccess.com";

describe("public discovery documents", () => {
  it("serves supported discovery documents without exposing account data", () => {
    const paths = [
      "/llms.txt",
      "/.well-known/api-catalog",
      "/openapi.json",
      "/.well-known/mcp/server-card.json",
      "/.well-known/oauth-protected-resource",
    ];

    for (const path of paths) {
      const result = routeDiscoveryRequest(
        new Request(`${origin}${path}`),
        accessTeamDomain
      );

      expect(result).not.toBeNull();
      expect(result?.status).toBe(200);
      expect(result?.headers.get("Cache-Control")).toContain("public");
      expect(result?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("publishes endpoint URLs using the request origin", async () => {
    const response = routeDiscoveryRequest(
      new Request(`${origin}/openapi.json`),
      accessTeamDomain
    );

    expect(response).not.toBeNull();
    const openApi = await response?.json();
    expect(openApi).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/accounts": { get: { operationId: "listAccounts" } },
        "/refresh": { post: { operationId: "requestRefresh" } },
      },
      servers: [{ url: `${origin}/api/v1` }],
    });
  });

  it("returns an RFC 9727 Linkset catalog with its registered media type", async () => {
    const response = routeDiscoveryRequest(
      new Request(`${origin}/.well-known/api-catalog`),
      accessTeamDomain
    );

    expect(response?.headers.get("Content-Type")).toContain(
      "application/linkset+json"
    );
    await expect(response?.json()).resolves.toMatchObject({
      linkset: [
        {
          anchor: `${origin}/api/v1`,
          "service-desc": [{ href: `${origin}/openapi.json` }],
        },
      ],
    });
  });

  it("uses the configured Access authorization server in OAuth metadata", async () => {
    const response = routeDiscoveryRequest(
      new Request(`${origin}/.well-known/oauth-protected-resource`),
      accessTeamDomain
    );

    expect(response).not.toBeNull();
    await expect(response?.json()).resolves.toMatchObject({
      authorization_servers: [accessTeamDomain],
      resource: `${origin}/mcp`,
    });
  });

  it("supports HEAD and rejects non-read methods for discovery paths", async () => {
    const head = routeDiscoveryRequest(
      new Request(`${origin}/.well-known/api-catalog`, { method: "HEAD" }),
      accessTeamDomain
    );

    const post = routeDiscoveryRequest(
      new Request(`${origin}/llms.txt`, { method: "POST" }),
      accessTeamDomain
    );

    expect(head?.status).toBe(200);
    expect(head?.headers.get("Link")).toContain('rel="api-catalog"');
    await expect(head?.text()).resolves.toBe("");
    expect(post?.status).toBe(405);
    expect(post?.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("does not intercept application routes", () => {
    expect(
      routeDiscoveryRequest(
        new Request(`${origin}/api/v1/accounts`),
        accessTeamDomain
      )
    ).toBeNull();
  });
});
