# Revolut integration status

BankGlass is designed to remain read-only with respect to financial institutions. Revolut support therefore must use a documented, consent-based interface and must never depend on Revolut credentials, private mobile endpoints, browser scraping, or payment scopes.

## New Zealand personal accounts

As of September 2026, Revolut supports personal customers resident in New Zealand, but Revolut does not expose a simple personal developer token for reading a New Zealand retail account. Revolut's public Open Banking API is intended for regulated third-party providers or approved/partner integrations. GoCardless Bank Account Data is a PSD2/Open Banking aggregation product for the UK/EEA and should not be treated as a supported connector for a New Zealand Revolut retail account.

For that reason, BankGlass intentionally does not ship a fake or unofficial `RevolutProvider` for New Zealand personal accounts.

## Accepted implementation paths

A future live Revolut connector may be added when at least one of these is available for the user's account entity:

1. An official Revolut account-information integration that permits the account owner to authorize read-only access.
2. A regulated intermediary with explicit support for New Zealand Revolut retail accounts and a production tier suitable for personal/single-user use.
3. A documented Revolut export/import mechanism that can be implemented without collecting Revolut login credentials.

Any live connector must satisfy the `BankProviderService` contract and normalize accounts, balances, posted transactions, and pending transactions into the existing BankGlass domain.

## Security requirements

A Revolut integration must:

- request account-information permissions only;
- never request or implement payment initiation;
- never store Revolut usernames, passwords, passcodes, device secrets, or MFA material;
- keep provider tokens in Worker secrets rather than Durable Object records;
- validate all upstream responses with Effect Schema before normalization;
- map provider failures to the existing typed provider errors;
- respect upstream rate limits and consent expiry;
- avoid logging raw account, transaction, token, or consent payloads;
- include deterministic tests that do not call the live provider.

## Provider capability contract

`BankProviderService` exposes optional provider metadata including a stable ID, a display name, and whether the source supports an explicit refresh operation. Existing providers that do not declare metadata retain the current refresh behaviour for backward compatibility.

Synchronization uses `supportsRefresh` before reserving a refresh cooldown, calling the provider's refresh operation, recording a refresh request, or waiting for upstream refresh propagation. This keeps Akahu's current behaviour unchanged while allowing a future Revolut/Open Banking provider to declare that freshness is controlled by the upstream consent/provider rather than by an explicit refresh endpoint.

## CI expectations

The existing `CI` workflow is the verification gate for this foundation and future provider work. Pull requests run:

- TypeScript typechecking;
- Knip dead-code checks;
- Vitest, including provider capability tests;
- Ultracite checks.

Future Revolut work should extend the existing workflow only when a new verification boundary cannot be covered by those commands.

## References

- Revolut Open Banking API: https://developer.revolut.com/docs/api/open-banking
- Revolut New Zealand account availability: https://help.revolut.com/en-NZ/help/profile-and-plan/profile-plan/verifying-identity/what-countries-are-supported/
- Revolut New Zealand account details: https://help.revolut.com/en-NZ/help/transfers/inbound-transfers/how-to-receive-money-from-another-bank/what-account-details-should-i-use-to-transfer-money-to-my-revolut-account/what-account-details-are-available-for-me/
