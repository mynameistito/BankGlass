import { Context, Duration, Effect, Layer } from "effect";

import type { BankConnection } from "@/domain/connection";
import type { ProviderId } from "@/domain/identifiers";
import type {
  ProviderAccount,
} from "@/domain/account";
import type {
  ProviderPendingTransaction,
  ProviderPostedTransaction,
} from "@/domain/transaction";
import {
  DuplicateProviderRegistrationError,
  ProviderNotRegisteredError,
} from "@/errors/provider-registry";
import type {
  AuthenticationError,
  InvalidProviderResponseError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "@/errors";

/** Failures that may cross a banking-provider adapter boundary. */
export type BankProviderError =
  | AuthenticationError
  | ProviderRateLimitError
  | ProviderUnavailableError
  | InvalidProviderResponseError;

/** Provider-owned explicit refresh operation and its required timing policy. */
export interface ExplicitRefreshStrategy {
  readonly _tag: "Explicit";
  /** Minimum time between explicit upstream refresh requests. */
  readonly minimumInterval: Duration.Duration;
  /** Delay before reading provider cache after accepting a refresh request. */
  readonly propagationDelay: Duration.Duration;
  /** Request an upstream refresh for one connection. */
  readonly request: (
    connection: BankConnection
  ) => Effect.Effect<void, BankProviderError>;
}

/** Material upstream freshness strategies understood by synchronization policy. */
export type RefreshStrategy =
  | ExplicitRefreshStrategy
  | { readonly _tag: "ProviderManaged" }
  | { readonly _tag: "Unavailable" };

/** Pending-transaction operation exposed only by providers that implement it. */
export type PendingTransactionsStrategy =
  | {
      readonly _tag: "Available";
      readonly read: (
        connection: BankConnection
      ) => Effect.Effect<readonly ProviderPendingTransaction[], BankProviderError>;
    }
  | { readonly _tag: "Unavailable" };

/** Application-owned contract implemented by one bundled banking-data adapter. */
export interface BankProviderAdapter {
  /** Human-readable name used only for safe diagnostics and source metadata. */
  readonly displayName: string;
  /** Stable BankGlass provider identifier. */
  readonly id: ProviderId;
  /** Read and normalize accounts for one configured connection. */
  readonly readAccounts: (
    connection: BankConnection
  ) => Effect.Effect<readonly ProviderAccount[], BankProviderError>;
  /** Read and normalize posted transactions for one configured connection. */
  readonly readPostedTransactions: (input: {
    readonly connection: BankConnection;
    readonly start: string | null;
  }) => Effect.Effect<readonly ProviderPostedTransaction[], BankProviderError>;
  /** Pending-transaction behavior for this provider. */
  readonly pendingTransactions: PendingTransactionsStrategy;
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

/**
 * Construct a provider registry while rejecting duplicate stable provider IDs.
 *
 * @param providers - Provider adapters bundled into the current deployment.
 * @returns A provider registry service or a duplicate-registration error.
 */
export const makeProviderRegistry = (providers: readonly BankProviderAdapter[]) =>
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

/** Create a duration from whole seconds for provider refresh metadata. */
export const refreshSeconds = (seconds: number) => Duration.seconds(seconds);
