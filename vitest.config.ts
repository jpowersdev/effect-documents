import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/utils/**", "test/consumer/**"],
    globalSetup: ["test/utils/postgresServer.ts"],
    sequence: { concurrent: true }
  }
})
