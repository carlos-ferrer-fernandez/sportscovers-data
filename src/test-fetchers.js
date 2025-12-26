import fs from "fs";
import path from "path";
import config from "./publishers.json" assert { type: "json" }; // <-- change to your real json file
import { fetchCover } from "./fetchers.js"; // <-- change path to your updated fetchers file

const dateStr = "2025-12-26"; // Paris date you want
const outputDir = path.join(process.cwd(), "covers-test");

fs.mkdirSync(outputDir, { recursive: true });

async function run() {
  const pubs = config.publishers.filter((p) => p.enabled);

  const results = { ok: [], fail: [] };

  for (const p of pubs) {
    process.stdout.write(`Testing ${p.id}... `);
    try {
      const res = await fetchCover(p, dateStr, outputDir, pubs);
      console.log(`OK  (${res.source}) -> ${res.localFile}`);
      results.ok.push({ id: p.id, source: res.source, url: res.url });
    } catch (e) {
      console.log(`FAIL -> ${e.message}`);
      results.fail.push({ id: p.id, error: String(e.message || e) });
    }
  }

  // Save a log file you can paste back here
  fs.writeFileSync(
    path.join(outputDir, `log-${dateStr}.json`),
    JSON.stringify(results, null, 2),
    "utf8"
  );

  console.log("\nSummary:");
  console.log("OK:", results.ok.map((x) => x.id).join(", "));
  console.log("FAIL:", results.fail.map((x) => x.id).join(", "));
  console.log(`\nWrote log to: ${path.join(outputDir, `log-${dateStr}.json`)}`);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});