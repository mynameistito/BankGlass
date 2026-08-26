import { Data } from "effect";

export class AuthenticationError extends Data.TaggedError(
  "AuthenticationError"
)<{ readonly message: string }> {}
export class ProviderRateLimitError extends Data.TaggedError(
  "ProviderRateLimitError"
)<{ readonly retryAfterSeconds: number | null }> {}
export class ProviderUnavailableError extends Data.TaggedError(
  "ProviderUnavailableError"
)<{ readonly operation: string; readonly cause: unknown }> {}
export class RefreshCooldownError extends Data.TaggedError(
  "RefreshCooldownError"
)<{ readonly retryAt: string }> {}
export class InvalidProviderResponseError extends Data.TaggedError(
  "InvalidProviderResponseError"
)<{ readonly operation: string; readonly details: string }> {}
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}
export class UnauthorizedApiRequestError extends Data.TaggedError(
  "UnauthorizedApiRequestError"
)<Record<string, never>> {}
export class UnauthorizedAccessRequestError extends Data.TaggedError(
  "UnauthorizedAccessRequestError"
)<Record<string, never>> {}
export class InvalidRequestError extends Data.TaggedError(
  "InvalidRequestError"
)<{ readonly message: string }> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string;
}> {}
export class ApiRateLimitError extends Data.TaggedError("ApiRateLimitError")<{
  readonly retryAfterSeconds: number;
}> {}
export class SyncInProgressError extends Data.TaggedError(
  "SyncInProgressError"
)<Record<string, never>> {}
