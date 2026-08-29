import { Data } from "effect";

/** Indicates that a requested cached resource does not exist. */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  /** Kind of resource that could not be found. */
  readonly resource: string;
}> {}
