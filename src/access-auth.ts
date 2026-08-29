import { Effect } from "effect";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import type { RuntimeConfig } from "@/config";
import { UnauthorizedAccessRequestError } from "@/errors";

type AccessJwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new WeakMap<typeof fetch, Map<string, AccessJwks>>();
const getAccessJwks = (config: RuntimeConfig, fetchJwks: typeof fetch) => {
  let domainJwks = jwksCache.get(fetchJwks);
  if (domainJwks === undefined) {
    domainJwks = new Map();
    jwksCache.set(fetchJwks, domainJwks);
  }
  const existing = domainJwks.get(config.accessTeamDomain);
  if (existing !== undefined) {
    return existing;
  }
  const jwks = createRemoteJWKSet(
    new URL(`${config.accessTeamDomain}/cdn-cgi/access/certs`),
    {
      [customFetch]: (url, options) => fetchJwks(url, options),
      timeoutDuration: 3000,
    }
  );
  domainJwks.set(config.accessTeamDomain, jwks);
  return jwks;
};

/** Verify the Cloudflare Access assertion attached to an origin request. */
export const authenticateAccess = (
  request: Request,
  config: RuntimeConfig,
  fetchJwks: typeof fetch = fetch
) =>
  Effect.tryPromise({
    catch: () => new UnauthorizedAccessRequestError({}),
    try: async () => {
      const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
      if (assertion === null) {
        throw new TypeError("Missing Access assertion");
      }
      const jwks = getAccessJwks(config, fetchJwks);
      await jwtVerify(assertion, jwks, {
        algorithms: ["RS256"],
        audience: config.accessAudience,
        issuer: config.accessTeamDomain,
      });
    },
  });
