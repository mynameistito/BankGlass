import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { BankConnection } from "@/domain/connection";
import {
  ConnectionIdSchema,
  ProviderIdSchema,
} from "@/domain/identifiers";
import type { BankProviderAdapter } from "@/provider-registry";
import { ProviderRegistry, providerRegistryLayer } from "@/provider-registry";

const providerId = Schema.decodeUnknownSync(ProviderIdSchema)("contract-test");
const unknownProviderId = Schema.decodeUnknownSync(ProviderIdSchema)("unknown");
const connection: BankConnection = {
  authorization: { _tag: "Connected" },
  createdAt: "2026-09-07T00:00:00.000Z",
  enabled: true,
  id: Schema.decodeUnknownSync(ConnectionIdSchema)("connection_contract_test"),
  label: "Contract test",
  lastSyncAt: null,
  metadata: {},
  providerId,
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const adapter: BankProviderAdapter = {
  displayName: "Contract provider",
  id: providerId,
  pendingTransactions: { _tag: "Unavailable" },
  readSnapshot: () => Effect.succeed({ accounts: [], pending: [], posted: [] }),
  refresh: { _tag: "ProviderManaged" },
};

describe("provider adapter contract", () => {
  it("resolves a registered adapter through the application-owned registry", async () => {
    const resolved = await Effect.runPromise(
      ProviderRegistry.pipe(
        Effect.flatMap((registry) => registry.get(providerId)),
        Effect.provide(providerRegistryLayer([adapter]))
      )
    );

    expect(resolved).toBe(adapter);
    await expect(
      Effect.runPromise(resolved.readSnapshot({ connection, start: null }))
    ).resolves.toStrictEqual({ accounts: [], pending: [], posted: [] });
  });

  it("rejects duplicate stable provider IDs", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        ProviderRegistry.pipe(
          Effect.provide(providerRegistryLayer([adapter, adapter]))
        )
      )
    );

    expect(error._tag).toBe("DuplicateProviderRegistrationError");
  });

  it("returns a typed error for an unregistered provider", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        ProviderRegistry.pipe(
          Effect.flatMap((registry) => registry.get(unknownProviderId)),
          Effect.provide(providerRegistryLayer([adapter]))
        )
      )
    );

    expect(error).toMatchObject({
      _tag: "ProviderNotRegisteredError",
      providerId: unknownProviderId,
    });
  });

  it("keeps payment operations outside the read-only provider contract", () => {
    expect("initiatePayment" in adapter).toBeFalsy();
    expect("createPayment" in adapter).toBeFalsy();
  });
});
