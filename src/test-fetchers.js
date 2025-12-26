import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCover } from "./fetchers.js"; // if fetchers.js is also in /src

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dateStr = "2025-12-26";
const outputDir = path.join(__dirname, "covers-test");

fs.mkdirSync(outputDir, { recursive: true });

// IMPORTANT: this assumes publishers.json is in /src.
// If you placed it in the repo root, change this path accordingly.
const configPath = path.join(__dirname, "publishers.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const pubs = (config.publishers || []).filter((p) => p.enabled);

async function run() {
  const results = { ok: [], fail: [] };

  for (const p of pubs) {
    process.stdout.write(`Testing ${p.id}... `);
    try {
      const res = await fetchCover(p, dateStr, outputDir, pubs);
      console.log(`OK (${res.source})`);
      results.ok.push({ id: p.id, source: res.source, url: res.url });
    } catch (e) {
      console.log(`FAIL (${e.message})`);
      results.fail.push({ id: p.id, error: String(e.message || e) });
    }
  }

  const logFile = path.join(outputDir, `log-${dateStr}.json`);
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nSaved log: ${logFile}`);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});