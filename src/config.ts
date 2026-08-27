import { Effect, Schema } from "effect";

import { InvalidRequestError } from "./errors";

const PositiveIntegerString = Schema.String.pipe(
  Schema.filter((value) => /^\d+$/u.test(value) && Number(value) > 0)
);
const HttpsOrigin = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  })
);
const Hostname = Schema.String.pipe(
  Schema.filter(
    (value) =>
      value.length > 0 &&
      value.length <= 253 &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)
  )
);
const RuntimeConfigSchema = Schema.Struct({
  accessAppHostname: Hostname,
  accessAudience: Schema.String.pipe(Schema.minLength(1)),
  accessTeamDomain: HttpsOrigin,
  akahuAppToken: Schema.String,
  akahuUserToken: Schema.String,
  apiBaseUrl: Schema.String,
  apiBearerToken: Schema.String,
  apiRateLimitPerMinute: PositiveIntegerString,
  refreshCooldownSeconds: PositiveIntegerString,
  syncLookbackDays: PositiveIntegerString,
});
export type RuntimeConfig = typeof RuntimeConfigSchema.Type;

interface ConfigEnv {
  readonly ACCESS_APP_HOSTNAME: string;
  readonly ACCESS_POLICY_AUD: string;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly AKAHU_API_BASE_URL: string;
  readonly AKAHU_APP_TOKEN: string;
  readonly AKAHU_USER_TOKEN: string;
  readonly API_BEARER_TOKEN: string;
  readonly API_RATE_LIMIT_PER_MINUTE: string;
  readonly REFRESH_COOLDOWN_SECONDS: string;
  readonly SYNC_LOOKBACK_DAYS: string;
}

export const parseConfig = (env: ConfigEnv) =>
  Schema.decodeUnknown(RuntimeConfigSchema)({
    accessAppHostname: env.ACCESS_APP_HOSTNAME,
    accessAudience: env.ACCESS_POLICY_AUD,
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
    akahuAppToken: env.AKAHU_APP_TOKEN,
    akahuUserToken: env.AKAHU_USER_TOKEN,
    apiBaseUrl: env.AKAHU_API_BASE_URL,
    apiBearerToken: env.API_BEARER_TOKEN,
    apiRateLimitPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
    refreshCooldownSeconds: env.REFRESH_COOLDOWN_SECONDS,
    syncLookbackDays: env.SYNC_LOOKBACK_DAYS,
  }).pipe(
    Effect.mapError(
      () =>
        new InvalidRequestError({
          message: "Worker configuration is missing or invalid",
        })
    )
  );
