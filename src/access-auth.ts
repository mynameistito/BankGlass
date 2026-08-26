import { Effect } from "effect";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import type { RuntimeConfig } from "./config";
import { UnauthorizedAccessRequestError } from "./errors";

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
      const jwks = createRemoteJWKSet(
        new URL(`${config.accessTeamDomain}/cdn-cgi/access/certs`),
        {
          [customFetch]: (url, options) => fetchJwks(url, options),
          timeoutDuration: 3000,
        }
      );
      await jwtVerify(assertion, jwks, {
        algorithms: ["RS256"],
        audience: config.accessAudience,
        issuer: config.accessTeamDomain,
      });
    },
  });
