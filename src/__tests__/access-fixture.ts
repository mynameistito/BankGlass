import { exportJWK, generateKeyPair, SignJWT } from "jose";

const keyId = "test-access-key";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);

/** Test-only JWKS served by the mocked Access team domain. */
const accessJwks = {
  keys: [{ ...jwk, alg: "RS256", kid: keyId, use: "sig" }],
};

/** Sign a short-lived test assertion accepted by the configured Access app. */
export const makeAccessAssertion = () =>
  new SignJWT({ email: "owner@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setAudience("REPLACE_WITH_ACCESS_AUD")
    .setIssuer("https://replace-with-team-name.cloudflareaccess.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

/** Return the test JWKS without making an external request. */
export const fetchAccessJwks: typeof fetch = () =>
  Promise.resolve(Response.json(accessJwks));
