import { Data } from "effect";

/** Indicates that composition attempted to register the same provider twice. */
export class DuplicateProviderRegistrationError extends Data.TaggedError(
  "DuplicateProviderRegistrationError"
)<{
  /** Duplicate provider identifier. */
  readonly providerId: string;
}> {}
