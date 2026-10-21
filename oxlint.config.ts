import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["github", "jsdoc-js", "sonarjs", "tsdoc"]);

export default defineConfig({
  env: core.env,
  extends: [
    antiSlop,
    core,
    vitest,
    jsPlugins,
    selectJsPlugins(["github", "sonarjs"]),
  ],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: { typeAware: true },
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: ["./*", "../*", "../../*"],
      },
    ],
  },
});
