import { Context, Effect, Layer } from "effect";
import type { Duration } from "effect/Duration";

import type { ProviderAccount } from "@/domain/account";
import type { BankConnection } from "@/domain/connection";
import type { ProviderId } from "@/domain/identifiers";
import type {
  ProviderPendingTransaction,
  ProviderPostedTransaction,
} from "@/domain/transaction";
import type {
  AuthenticationError,
  InvalidProviderResponseError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "@/errors";
import { DuplicateProviderRegistrationError } from "@/errors/duplicate-provider-registration";
import { ProviderNotRegisteredError } from "@/errors/provider-not-registered";

/** Failures that may cross a banking-provider adapter boundary. */
export type BankProviderError =
  | AuthenticationError
  | ProviderRateLimitError
  | ProviderUnavailableError
  | InvalidProviderResponseError;

/** Domain-shaped data returned by one provider read operation. */
interface ProviderReadSnapshot {
  readonly accounts: readonly ProviderAccount[];
  readonly pending: readonly ProviderPendingTransaction[];
  readonly posted: readonly ProviderPostedTransaction[];
}

/** Provider-owned explicit refresh operation and its required timing policy. */
interface ExplicitRefreshStrategy {
  readonly _tag: "Explicit";
  /** Minimum time between explicit upstream refresh requests. */
  readonly minimumInterval: Duration;
  /** Delay before reading provider cache after accepting a refresh request. */
  readonly propagationDelay: Duration;
  /** Request an upstream refresh for one connection. */
  readonly request: (
    connection: BankConnection
  ) => Effect.Effect<void, BankProviderError>;
}

/** Material upstream freshness strategies understood by synchronization policy. */
type RefreshStrategy =
  | ExplicitRefreshStrategy
  | { readonly _tag: "ProviderManaged" }
  | { readonly _tag: "Unavailable" };

/** Whether the provider can expose pending transactions in its normalized snapshot. */
type PendingTransactionsStrategy =
  | { readonly _tag: "Available" }
  | { readonly _tag: "Unavailable" };

/** Application-owned contract implemented by one bundled banking-data adapter. */
export interface BankProviderAdapter {
  /** Human-readable name used only for safe diagnostics and source metadata. */
  readonly displayName: string;
  /** Stable BankGlass provider identifier. */
  readonly id: ProviderId;
  /** Pending-transaction behavior for this provider. */
  readonly pendingTransactions: PendingTransactionsStrategy;
  /** Read and normalize one connection without exposing vendor pagination or schemas. */
  readonly readSnapshot: (input: {
    readonly connection: BankConnection;
    readonly start: string | null;
  }) => Effect.Effect<ProviderReadSnapshot, BankProviderError>;
  /** Upstream freshness behavior for this provider. */
  readonly refresh: RefreshStrategy;
}

/** Runtime directory of provider adapters selected by the composition root. */
export interface ProviderRegistryService {
  /** Resolve one registered provider adapter. */
  readonly get: (
    providerId: ProviderId
  ) => Effect.Effect<BankProviderAdapter, ProviderNotRegisteredError>;
  /** Provider identifiers bundled into this deployment. */
  readonly providerIds: readonly ProviderId[];
}

/** Effect service for the deployment's bundled provider registry. */
export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  ProviderRegistryService
>()("@bankglass/ProviderRegistry") {}

const makeProviderRegistry = (providers: readonly BankProviderAdapter[]) =>
  Effect.gen(function* buildProviderRegistry() {
    const byId = new Map<ProviderId, BankProviderAdapter>();
    for (const provider of providers) {
      if (byId.has(provider.id)) {
        return yield* Effect.fail(
          new DuplicateProviderRegistrationError({ providerId: provider.id })
        );
      }
      byId.set(provider.id, provider);
    }
    return ProviderRegistry.of({
      get: (providerId) => {
        const provider = byId.get(providerId);
        return provider === undefined
          ? Effect.fail(new ProviderNotRegisteredError({ providerId }))
          : Effect.succeed(provider);
      },
      providerIds: [...byId.keys()],
    });
  });

/** Provide a validated provider registry as an Effect layer. */
export const providerRegistryLayer = (providers: readonly BankProviderAdapter[]) =>
  Layer.effect(ProviderRegistry, makeProviderRegistry(providers));
