import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { compatibilityDate: "2026-08-22", bindings: {
      TEST_MIGRATIONS: await readD1Migrations("./migrations"),
      RELAY_ORIGIN: "https://relay.test", ENROLLMENT_PEPPER: "synthetic-enrollment-pepper-for-local-tests-only",
      PAIRING_PEPPER: "synthetic-pairing-pepper-for-local-tests-only", PUSH_TOKEN_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    } },
  })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
});
