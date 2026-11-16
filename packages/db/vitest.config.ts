import { defineConfig } from "vitest/config";

import { coverageConfig } from "../../vitest.coverage.mjs";

export default defineConfig({ test: { include: ["src/**/*.test.{ts,tsx}"], coverage: coverageConfig } });
