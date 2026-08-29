import { Data } from "effect";

/** Indicates that a REST request lacks the configured bearer token. */
export class UnauthorizedApiRequestError extends Data.TaggedError(
  "UnauthorizedApiRequestError"
)<Record<string, never>> {}
