import { Data } from "effect";

/** Indicates that a request lacks a valid Cloudflare Access assertion. */
export class UnauthorizedAccessRequestError extends Data.TaggedError(
  "UnauthorizedAccessRequestError"
)<Record<string, never>> {}
