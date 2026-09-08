import { Schema } from "effect";

import { ConnectionIdSchema } from "@/domain/identifiers";

/** BankGlass connection ID reserved for the migrated aggregate Akahu connection. */
export const AkahuDefaultConnectionId = Schema.decodeUnknownSync(
  ConnectionIdSchema
)("connection_akahu_default");
