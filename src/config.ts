import { Effect, Predicate, Schema } from "effect";
import type { SchemaIssue } from "effect";

import { NonEmptyStringSchema } from "@/domain/identifiers";
import { InvalidRequestError } from "@/errors";

const PositiveIntegerString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => /^\d+$/u.test(value) && Number(value) > 0
    )
  )
);

const HttpsOrigin = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      try {
        const url = new URL(value);

        return url.protocol === "https:" && url.origin === value;
      } catch {
        return false;
      }
    })
  )
);

const HttpsApiBaseUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      try {
        const url = new URL(value);

        return [
          url.protocol === "https:",
          url.hostname.length > 0,
          url.username.length === 0,
          url.password.length === 0,
          url.search.length === 0,
          url.hash.length === 0,
        ].every(Boolean);
      } catch {
        return false;
      }
    })
  )
);

const Hostname = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.length > 0 &&
        value.length <= 253 &&
        /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)
    )
  )
);

const RuntimeConfigSchema = Schema.Struct({
  accessAppHostname: Hostname,
  accessAudience: NonEmptyStringSchema,
  accessTeamDomain: HttpsOrigin,
  akahuAppToken: NonEmptyStringSchema,
  akahuUserToken: NonEmptyStringSchema,
  apiBaseUrl: HttpsApiBaseUrl,
  apiBearerToken: NonEmptyStringSchema,
  apiRateLimitPerMinute: PositiveIntegerString,
  refreshCooldownSeconds: PositiveIntegerString,
  syncLookbackDays: PositiveIntegerString,
});

const configFields = new Set([
  "accessAppHostname",
  "accessAudience",
  "accessTeamDomain",
  "akahuAppToken",
  "akahuUserToken",
  "apiBaseUrl",
  "apiBearerToken",
  "apiRateLimitPerMinute",
  "refreshCooldownSeconds",
  "syncLookbackDays",
]);

const collectConfigFields = (
  issue: SchemaIssue.Issue,
  fields: Set<string>
): void => {
  switch (issue._tag) {
    case "Pointer": {
      for (const segment of issue.path) {
        if (Predicate.isString(segment) && configFields.has(segment)) {
          fields.add(segment);
        }
      }

      collectConfigFields(issue.issue, fields);
      break;
    }

    case "Composite":
    case "AnyOf": {
      for (const child of issue.issues) {
        collectConfigFields(child, fields);
      }

      break;
    }

    case "Encoding": {
      collectConfigFields(issue.issue, fields);
      break;
    }

    case "Filter": {
      collectConfigFields(issue.issue, fields);
      break;
    }

    case "OneOf":
    case "Forbidden":
    case "InvalidType":
    case "InvalidValue":
    case "MissingKey":
    case "UnexpectedKey": {
      break;
    }

    default: {
      break;
    }
  }
};

const mapConfigError = (error: Schema.SchemaError): InvalidRequestError => {
  const fields = new Set<string>();
  collectConfigFields(error.issue, fields);

  return new InvalidRequestError({
    message:
      fields.size === 0
        ? "Worker configuration is missing or invalid"
        : `Worker configuration is missing or invalid: ${[...fields].join(", ")}`,
  });
};

/** Parsed configuration required by the Worker, including sensitive credentials such as API tokens. */
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

/**
 * Parse and normalize Worker environment variables.
 *
 * @param env - Environment variables supplied by the Worker runtime.
 * @returns An Effect containing validated runtime configuration or an
 * `InvalidRequestError` when required configuration is missing or malformed.
 */
export const parseConfig = (env: ConfigEnv) =>
  Schema.decodeUnknownEffect(RuntimeConfigSchema)({
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
  }).pipe(Effect.mapError(mapConfigError));
