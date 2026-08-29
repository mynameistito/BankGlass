import { Data } from "effect";

/** Indicates a Durable Object storage or store-command failure. */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  /** Store operation being performed when the failure occurred. */
  readonly operation: string;
  /** Underlying failure, retained for diagnostics. */
  readonly cause: unknown;
}> {}
