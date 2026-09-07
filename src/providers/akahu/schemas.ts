import { Schema } from "effect";

const DateTime = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)))
  )
);
const NullableString = Schema.optional(Schema.NullOr(Schema.String));
const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number));
const Meta = Schema.optional(
  Schema.Struct({
    card_suffix: NullableString,
    code: NullableString,
    other_account: NullableString,
    particulars: NullableString,
    reference: NullableString,
  })
);

const AkahuAccount = Schema.Struct({
  _id: Schema.String,
  balance: Schema.optional(
    Schema.Struct({
      available: NullableNumber,
      currency: Schema.String,
      current: Schema.Number,
    })
  ),
  connection: Schema.Struct({ name: Schema.String }),
  formatted_account: NullableString,
  meta: Schema.optional(Schema.Struct({ holder: NullableString })),
  name: Schema.String,
  refreshed: Schema.optional(
    Schema.Struct({
      balance: Schema.optional(DateTime),
      transactions: Schema.optional(DateTime),
    })
  ),
  status: Schema.Literals(["ACTIVE", "INACTIVE"]),
  type: Schema.String,
});

const AkahuTransaction = Schema.Struct({
  _account: Schema.String,
  _id: Schema.String,
  amount: Schema.Number,
  balance: NullableNumber,
  category: Schema.optional(Schema.Struct({ name: Schema.String })),
  created_at: DateTime,
  date: DateTime,
  description: Schema.String,
  merchant: Schema.optional(Schema.Struct({ name: Schema.String })),
  meta: Meta,
  type: Schema.String,
  updated_at: DateTime,
});

const AkahuPendingTransaction = Schema.Struct({
  _account: Schema.String,
  amount: Schema.Number,
  date: DateTime,
  description: Schema.String,
  meta: Meta,
  type: Schema.String,
  updated_at: DateTime,
});

/** Akahu list-accounts response. */
export const AccountsResponse = Schema.Struct({
  items: Schema.Array(AkahuAccount),
  success: Schema.Literal(true),
});
/** Akahu paginated posted-transactions response. */
export const TransactionsResponse = Schema.Struct({
  cursor: Schema.optional(
    Schema.Struct({ next: Schema.NullOr(Schema.String) })
  ),
  items: Schema.Array(AkahuTransaction),
  success: Schema.Literal(true),
});
/** Akahu pending-transactions response. */
export const PendingResponse = Schema.Struct({
  items: Schema.Array(AkahuPendingTransaction),
  success: Schema.Literal(true),
});
/** Akahu refresh response. */
export const RefreshResponse = Schema.Struct({ success: Schema.Literal(true) });
