import { Context } from "effect";
import type { Effect } from "effect";

import type {
  BankAccount,
  PendingTransaction,
  PostedTransaction,
} from "@/domain";
import type {
  AuthenticationError,
  InvalidProviderResponseError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "@/errors";

/** Failures that can occur while reading from or refreshing the bank provider. */
export type BankProviderError =
  | AuthenticationError
  | ProviderRateLimitError
  | ProviderUnavailableError
  | InvalidProviderResponseError;
/** Provider operations required by the synchronization service. */
export interface BankProviderService {
  /** Read all accounts connected to the configured provider application. */
  readonly getAccounts: Effect.Effect<
    readonly BankAccount[],
    BankProviderError
  >;
  /** Read posted transactions from the optional start date onward. */
  readonly getTransactions: (options: {
    /** Inclusive provider date-time from which transactions are requested. */
    readonly start: string | null;
  }) => Effect.Effect<readonly PostedTransaction[], BankProviderError>;
  /** Read the provider's currently pending transactions. */
  readonly getPendingTransactions: Effect.Effect<
    readonly PendingTransaction[],
    BankProviderError
  >;
  /** Ask the provider to refresh its source data. */
  readonly requestRefresh: Effect.Effect<void, BankProviderError>;
}
/** Effect service tag for bank-provider operations. */
export class BankProvider extends Context.Service<
  BankProvider,
  BankProviderService
>()("@bankglass/BankProvider") {}
