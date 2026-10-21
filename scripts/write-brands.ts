import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { brandJsonSchemas, brandsModuleSource, compileBrands, type BrandSources } from "../packages/shared/src/brands/schema";

// Compiles the brands under brands/ into the files the apps read:
// packages/shared/src/brands/generated.ts, each brand's images under
// apps/admin/public/brand/<id>/, and JSON Schemas for editors. A brand's
// billing.json is checked and hashed but never copied anywhere. A test in
// scripts/brands.test.ts fails when any of them falls behind brands/.

export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export function readBrandSources(root = repositoryRoot): BrandSources {
  const folder = join(root, "brands");
  const brands: BrandSources["brands"] = {};
  for (const id of readdirSync(folder)) {
    const path = join(folder, id);
    if (!statSync(path).isDirectory()) continue;
    const assets: Record<string, Uint8Array> = {};
    const names = readdirSync(path);
    for (const name of names) {
      if (name !== "brand.json" && name !== "billing.json") assets[name] = readFileSync(join(path, name));
    }
    const json = (name: string): unknown => {
      try {
        return JSON.parse(readFileSync(join(path, name), "utf8"));
      } catch (error) {
        throw new Error(`brands/${id}/${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    brands[id] = { file: json("brand.json"), ...(names.includes("billing.json") ? { billing: json("billing.json") } : {}), assets };
  }
  return { index: JSON.parse(readFileSync(join(folder, "index.json"), "utf8")), brands };
}

/** Every file the build writes, by its path from the repository root. */
export function brandOutputs(sources: BrandSources): Map<string, string | Uint8Array> {
  const compiled = compileBrands(sources);
  const schemas = brandJsonSchemas();
  const outputs = new Map<string, string | Uint8Array>();
  outputs.set("packages/shared/src/brands/generated.ts", brandsModuleSource(compiled));
  outputs.set("brands/brand.schema.json", `${JSON.stringify(schemas.brand, null, 2)}\n`);
  outputs.set("brands/index.schema.json", `${JSON.stringify(schemas.index, null, 2)}\n`);
  outputs.set("brands/billing.schema.json", `${JSON.stringify(schemas.billing, null, 2)}\n`);
  for (const [path, bytes] of Object.entries(compiled.publicAssets)) outputs.set(`apps/admin/public${path}`, bytes);
  return outputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, content] of brandOutputs(readBrandSources())) {
    const target = join(repositoryRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`Wrote ${path}`);
  }
}
