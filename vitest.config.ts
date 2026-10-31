import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 20000,
    hookTimeout: 20000,
    // Design §11 relies on vi.useFakeTimers for deterministic schedules.
    fakeTimers: { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] },
  },
});
