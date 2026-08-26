import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: ["src/errors.ts"],
      // These tagged classes form one closed, colocated API error vocabulary.
      rules: { "eslint/max-classes-per-file": "off" },
    },
  ],
  // Effect's typed program composition uses callbacks; async/await would erase error and context channels.
  rules: { "promise/prefer-await-to-callbacks": "off" },
});
