import fs from 'fs';
import path from 'path';
import { fetchCover } from './fetchers.js';

// Load publishers using 'with' syntax for JSON imports in newer Node.js
import publishersData from './publishers.json' with { type: "json" };

const OUTPUT_DIR = './docs';
const DATA_DIR = path.join(OUTPUT_DIR, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

// Ensure directories exist
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

async function main() {
  const today = new Date().toISOString().split('T')[0];
  const results = [];

  console.log(`Starting scrape for ${today}...`);

  for (const publisher of publishersData.publishers) {
    if (!publisher.enabled) continue;

    console.log(`Processing ${publisher.name} (${publisher.country})...`);
    
    // Create country/publisher specific folder
    const publisherDir = path.join(IMAGES_DIR, publisher.country.toLowerCase(), publisher.id);
    if (!fs.existsSync(publisherDir)) fs.mkdirSync(publisherDir, { recursive: true });

    try {
      const result = await fetchCover(publisher, today, publisherDir);
      
      results.push({
        id: `${publisher.id}-${today}`,
        publisherId: publisher.id,
        publisherName: publisher.name,
        country: publisher.country,
        groupLabel: publisher.groupLabel, // Added groupLabel support
        date: today,
        imageMediumUrl: `./data/images/${publisher.country.toLowerCase()}/${publisher.id}/${result.localFile}`,
        sourceUrl: result.url,
        scrapedAt: new Date().toISOString()
      });
      console.log(`  -> Success: ${result.localFile}`);
    } catch (e) {
      console.error(`  -> Failed: ${e.message}`);
      results.push({
        id: `${publisher.id}-${today}`,
        publisherId: publisher.id,
        publisherName: publisher.name,
        country: publisher.country,
        groupLabel: publisher.groupLabel,
        date: today,
        error: e.message,
        scrapedAt: new Date().toISOString()
      });
    }
  }

  // Save today's results
  fs.writeFileSync(
    path.join(DATA_DIR, 'today.json'), 
    JSON.stringify(results, null, 2)
  );
  
  // Append to historical log (simplified)
  const historyFile = path.join(DATA_DIR, 'covers.json');
  let history = [];
  if (fs.existsSync(historyFile)) {
    history = JSON.parse(fs.readFileSync(historyFile));
  }
  history = [...history, ...results];
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

  console.log('Scrape complete.');
}

main();
