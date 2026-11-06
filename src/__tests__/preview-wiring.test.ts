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

const expression = (value: string) => ["$", `{{ ${value} }}`].join("");

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

  it("requires the isolated state configuration before preview deployment", () => {
    const start = workflow.indexOf(
      "- name: Validate preview deployment credentials"
    );

    const end = workflow.indexOf("- name: Validate production secrets", start);
    const validation = workflow.slice(start, end);

    expect(validation).toContain(
      "if: steps.preview_context.outputs.eligible == 'true'"
    );
    expect(validation).toContain('test -n "$ALCHEMY_PREVIEW_STATE_URL"');
    expect(validation).toContain(
      'test -n "$ALCHEMY_PREVIEW_STATE_EXPECTED_ORIGIN"'
    );
    expect(validation).toContain('test -n "$ALCHEMY_PREVIEW_STATE_TOKEN"');
  });

  it("passes the state bearer separately from Worker secrets", () => {
    const start = workflow.indexOf("- name: Run Alchemy deployment");
    const action = workflow.slice(start);
    const secretsStart = action.indexOf("worker-secrets: >-");
    const secretsEnd = action.indexOf("deploy-command:", secretsStart);
    const workerSecrets = action.slice(secretsStart, secretsEnd);

    expect(action).toContain(
      `preview-state-url: ${expression("vars.ALCHEMY_PREVIEW_STATE_URL")}`
    );
    expect(action).toContain(
      `preview-state-expected-origin: ${expression("vars.ALCHEMY_PREVIEW_STATE_EXPECTED_ORIGIN")}`
    );
    expect(action).toContain(
      `preview-state-token: ${expression("steps.op_preview_state.outputs.ALCHEMY_PREVIEW_STATE_TOKEN")}`
    );
    expect(workerSecrets).not.toContain("ALCHEMY_PREVIEW_STATE_TOKEN");
  });

  it("loads the state bearer only for an eligible preview", () => {
    const start = workflow.indexOf("- name: Load preview state bearer");

    const end = workflow.indexOf(
      "- name: Validate preview deployment credentials",
      start
    );

    const load = workflow.slice(start, end);

    expect(load).toContain(
      "if: steps.preview_context.outputs.eligible == 'true'"
    );
    expect(load).toContain("secrets.OP_TARGET_SERVICE_ACCOUNT_TOKEN");
    expect(load).toContain("ALCHEMY_PREVIEW_STATE_TOKEN: op://");
    expect(load).not.toContain("API_BEARER_TOKEN");
  });

  it("uses the real Workerd Durable Object fixture without a provider", async () => {
    const store = await Effect.runPromise(
      BankStore.pipe(Effect.provide(doBankStoreLive(env.BANK_STORE)))
    );

    const connections = await Effect.runPromise(store.listConnections);

    expect(connections).toStrictEqual(expect.any(Array));
  });
});
