import { defineConfig } from "tsup";

// One self-contained file, so `node dist/bin.js` runs without the workspace's
// TypeScript sources or a bundler in between.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node26",
  bundle: true,
  banner: { js: "#!/usr/bin/env node" },
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  noExternal: [/^@lobbystack\//, "zod"],
});
