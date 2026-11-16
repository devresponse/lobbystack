import { defineConfig } from "tsup";

export default defineConfig({
  // documentExtraction runs as a process of its own; see extractDocumentTextInChildProcess.
  entry: ["src/index.ts", "src/documentExtraction.ts"],
  outDir: "dist/runtime",
  format: ["esm"],
  platform: "node",
  target: "node26",
  bundle: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  splitting: false,
  sourcemap: true,
  clean: false,
  treeshake: true,
  noExternal: [/^@lobbystack\//],
});
