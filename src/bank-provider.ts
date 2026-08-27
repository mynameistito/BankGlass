import { Context } from "effect";
import type { Effect } from "effect";

import type {
  BankAccount,
  PendingTransaction,
  PostedTransaction,
} from "./domain";
import type {
  AuthenticationError,
  InvalidProviderResponseError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "./errors";

export type BankProviderError =
  | AuthenticationError
  | ProviderRateLimitError
  | ProviderUnavailableError
  | InvalidProviderResponseError;
export interface BankProviderService {
  readonly getAccounts: Effect.Effect<
    readonly BankAccount[],
    BankProviderError
  >;
  readonly getTransactions: (options: {
    readonly start: string | null;
  }) => Effect.Effect<readonly PostedTransaction[], BankProviderError>;
  readonly getPendingTransactions: Effect.Effect<
    readonly PendingTransaction[],
    BankProviderError
  >;
  readonly requestRefresh: Effect.Effect<void, BankProviderError>;
}
export class BankProvider extends Context.Service<
  BankProvider,
  BankProviderService
>()("@bankglass/BankProvider") {}
