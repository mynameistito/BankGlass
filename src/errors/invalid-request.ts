import { Data } from "effect";

/** Indicates malformed configuration or caller-supplied request data. */
export class InvalidRequestError extends Data.TaggedError(
  "InvalidRequestError"
)<{
  /** Human-readable explanation suitable for a client response. */
  readonly message: string;
}> {}
