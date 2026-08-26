import { Effect } from "effect";

import { UnauthorizedApiRequestError } from "./errors";

const bearer = /^Bearer (?<token>[A-Za-z0-9._~-]+)$/u;

export const authenticate = (request: Request, expected: string) =>
  Effect.gen(function* authenticateProgram() {
    const match = bearer.exec(request.headers.get("Authorization") ?? "");
    const provided = match?.groups?.["token"] ?? "";
    const encoder = new TextEncoder();
    const [providedHash, expectedHash] = yield* Effect.promise(() =>
      Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(provided)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
      ])
    );
    const left = new Uint8Array(providedHash);
    const right = new Uint8Array(expectedHash);
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
    }
    if (difference !== 0 || provided.length === 0) {
      return yield* Effect.fail(new UnauthorizedApiRequestError({}));
    }
  });
