import { Data } from "effect";

export class UnauthorizedApiRequestError extends Data.TaggedError(
  "UnauthorizedApiRequestError"
)<Record<string, never>> {}
