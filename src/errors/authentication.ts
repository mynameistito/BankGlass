import { Data } from "effect";

/** Indicates that the upstream provider rejected configured credentials. */
export class AuthenticationError extends Data.TaggedError(
  "AuthenticationError"
)<{
  /** Safe diagnostic message describing the authentication failure. */
  readonly message: string;
}> {}
