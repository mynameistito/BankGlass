import { Data } from "effect";

/** Indicates that a stored connection references no bundled provider adapter. */
export class ProviderNotRegisteredError extends Data.TaggedError(
  "ProviderNotRegisteredError"
)<{
  /** Provider identifier that could not be resolved. */
  readonly providerId: string;
}> {}

/** Indicates that composition attempted to register the same provider twice. */
export class DuplicateProviderRegistrationError extends Data.TaggedError(
  "DuplicateProviderRegistrationError"
)<{
  /** Duplicate provider identifier. */
  readonly providerId: string;
}> {}
