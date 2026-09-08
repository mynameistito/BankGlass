import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { BankConnection } from "@/domain/connection";
import { ConnectionIdSchema } from "@/domain/identifiers";
import { AkahuProviderId, makeAkahuProvider } from "@/providers/akahu/provider";

const connectionId = Schema.decodeUnknownSync(ConnectionIdSchema)(
  "connection_akahu_blank_scope"
);

const connection: BankConnection = {
  authorization: { _tag: "Connected" },
  createdAt: "2026-09-08T00:00:00.000Z",
  enabled: true,
  id: connectionId,
  label: "Blank Akahu scope",
  lastSyncAt: null,
  metadata: { akahuConnectionId: "   " },
  providerId: AkahuProviderId,
  updatedAt: "2026-09-08T00:00:00.000Z",
};

describe("Akahu connection scope", () => {
  it("rejects blank upstream connection IDs before transport", async () => {
    let requestCount = 0;
    const adapter = makeAkahuProvider(
      {
        appToken: Redacted.make("app-token"),
        baseUrl: "https://api.akahu.test",
        userToken: Redacted.make("user-token"),
      },
      () => {
        requestCount += 1;
        return Promise.resolve(Response.json({ items: [], success: true }));
      }
    );

    const error = await Effect.runPromise(
      Effect.flip(adapter.readSnapshot({ connection, start: null }))
    );

    expect({ requestCount, tag: error._tag }).toStrictEqual({
      requestCount: 0,
      tag: "InvalidProviderResponseError",
    });
  });
});
