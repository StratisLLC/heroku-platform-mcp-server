#!/usr/bin/env node
/**
 * Refresh the committed Heroku schema fixture used by the test suite.
 *
 * Usage:
 *   node packages/core/scripts/refresh-schema-fixture.mjs
 *
 * Behaviour:
 *   - GETs https://api.heroku.com/schema (no auth required for this endpoint).
 *   - Extracts a curated subset of definitions and writes it to
 *     packages/core/test/fixtures/heroku-schema.json.
 *   - Keeps the file small (~40 KB) so CI is fast and reviewers can read diffs.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "..", "test", "fixtures", "heroku-schema.json");

const KEEP = ["account", "app", "rate-limit", "team", "addon"];

async function main() {
  const response = await fetch("https://api.heroku.com/schema", {
    headers: { Accept: "application/vnd.heroku+json; version=3" },
  });
  if (response.status !== 200) {
    console.error(`heroku /schema returned ${response.status}`);
    process.exit(1);
  }
  const full = await response.json();
  const out = {
    $schema: full.$schema,
    type: full.type,
    description:
      "Heroku Platform API (minimised fixture). Refresh via packages/core/scripts/refresh-schema-fixture.mjs.",
    definitions: {},
  };
  for (const name of KEEP) {
    if (full.definitions[name]) out.definitions[name] = full.definitions[name];
  }
  await writeFile(fixturePath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${fixturePath} (${Object.keys(out.definitions).length} definitions).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
