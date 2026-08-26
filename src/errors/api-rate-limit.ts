import { Data } from "effect";

export class ApiRateLimitError extends Data.TaggedError("ApiRateLimitError")<{
  readonly retryAfterSeconds: number;
}> {}
