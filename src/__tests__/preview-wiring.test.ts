import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BankStore } from "@/bank-store";
import { doBankStoreLive } from "@/bank-store-do";
import { parseConfig } from "@/config";

import workflow from "../../.github/workflows/deploy.yml?raw";

const publicConfigSchema = z
  .object({
    AKAHU_API_BASE_URL: z.string(),
    API_RATE_LIMIT_PER_MINUTE: z.string(),
    REFRESH_COOLDOWN_SECONDS: z.string(),
    SYNC_LOOKBACK_DAYS: z.string(),
  })
  .strict();

describe("preview runtime wiring", () => {
  it("decodes the workflow's public defaults with synthetic secrets", async () => {
    const marker = "worker-config: >-";
    const start = workflow.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const [line] = workflow
      .slice(start + marker.length)
      .trimStart()
      .split("\n");

    const values = publicConfigSchema.parse(JSON.parse(line ?? "null"));

    const config = await Effect.runPromise(
      parseConfig({
        ...values,
        ACCESS_APP_HOSTNAME: "preview.example.test",
        ACCESS_POLICY_AUD: "fixture-audience",
        ACCESS_TEAM_DOMAIN: "https://access.example.test",
        AKAHU_APP_TOKEN: "preview-provider-disabled",
        AKAHU_USER_TOKEN: "preview-provider-disabled",
        API_BEARER_TOKEN: "fixture-preview-bearer",
      })
    );

    expect(config.apiRateLimitPerMinute).toBe("60");
    expect(config.refreshCooldownSeconds).toBe("3600");
    expect(config.syncLookbackDays).toBe("14");
  });

  it("references the preview bearer and inert provider credentials", () => {
    const start = workflow.indexOf("worker-secrets: >-");
    const end = workflow.indexOf("deploy-command:", start);
    const secrets = workflow.slice(start, end);

    expect(secrets).toContain(
      "steps.op_preview.outputs.PREVIEW_API_BEARER_TOKEN"
    );
    expect(secrets).not.toContain("steps.op_production");
    expect(secrets).toContain("preview-provider-disabled");
  });

  it("uses the real Workerd Durable Object fixture without a provider", async () => {
    const store = await Effect.runPromise(
      BankStore.pipe(Effect.provide(doBankStoreLive(env.BANK_STORE)))
    );

    const connections = await Effect.runPromise(store.listConnections);

    expect(connections).toStrictEqual(expect.any(Array));
  });
});
