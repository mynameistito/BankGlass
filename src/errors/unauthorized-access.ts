import { Data } from "effect";

export class UnauthorizedAccessRequestError extends Data.TaggedError(
  "UnauthorizedAccessRequestError"
)<Record<string, never>> {}
