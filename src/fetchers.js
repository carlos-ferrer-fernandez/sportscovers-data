import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function downloadImage(url, filepath) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
  await pipeline(response.body, fs.createWriteStream(filepath));
}

async function fetchWithFallback(urls) {
  for (const url of urls) {
    try {
      console.log(`Trying to fetch: ${url}`);
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Cookie': 'euconsent-v2=ACCEPTED',
        }
      });
      
      if (response.ok) {
        const html = await response.text();
        return { html, url, success: true };
      }
    } catch (error) {
      console.log(`Error fetching ${url}: ${error.message}`);
    }
  }
  return { success: false };
}

// Helper to find the biggest image and REJECT logos
function findBestCoverImage($, html) {
  // Candidates array
  const candidates = [];

  // 1. Open Graph (The "Silver Bullet" for Frontpages.com)
  const ogImg = $('meta[property="og:image"]').attr('content');
  if (ogImg) candidates.push(ogImg);

  // 2. Twitter Card Image (Backup)
  const twitterImg = $('meta[name="twitter:image"]').attr('content');
  if (twitterImg) candidates.push(twitterImg);

  // 3. Kiosko.net specific
  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    
    if (src.includes('750') || src.includes('portada') || src.includes('front-page')) {
      candidates.push(src);
    }
  });

  // FILTERING LOGIC
  for (const img of candidates) {
    if (!img) continue;
    
    // Reject known logo patterns
    if (img.includes('logo') || img.includes('icon') || img.includes('avatar')) {
      console.log(`Skipping logo-like image: ${img}`);
      continue;
    }
    
    return img; // Return the first valid candidate
  }
  
  return null;
}

// Main fetcher function called by build.js
export async function fetchCover(publisher, date, outputDir) {
  const fetcher = fetchers[publisher.id];
  if (!fetcher) throw new Error(`No fetcher for ${publisher.id}`);

  // Execute the fetcher logic which now handles multiple sources internally
  const imageUrl = await fetcher();
  
  if (!imageUrl) {
    console.error(`[FAILURE] Could not find any cover for ${publisher.id}`);
    return null; // Return null instead of throwing to allow other papers to proceed
  }

  // Download the image
  const filename = `${date}-medium.jpg`;
  const filepath = path.join(outputDir, filename);
  
  // Handle relative URLs (Kiosko sometimes uses them)
  const finalUrl = imageUrl.startsWith('http') ? imageUrl : `https://es.kiosko.net${imageUrl}`;
  
  try {
    await downloadImage(finalUrl, filepath);
    console.log(`[SUCCESS] Downloaded cover for ${publisher.id}`);
    return { localFile: filename, url: finalUrl };
  } catch (err) {
    console.error(`[ERROR] Failed to download image from ${finalUrl}: ${err.message}`);
    return null;
  }
}

// Helper to try multiple sources sequentially
async function trySources(sources) {
  for (const sourceUrl of sources) {
    console.log(`Attempting source: ${sourceUrl}`);
    const { html, success } = await fetchWithFallback([sourceUrl]);
    
    if (success) {
      const $ = cheerio.load(html);
      const image = findBestCoverImage($, html);
      if (image) {
        console.log(`Found image on ${sourceUrl}: ${image}`);
        return image;
      } else {
        console.log(`Page loaded but NO image found on ${sourceUrl}`);
      }
    }
  }
  return null;
}

export const fetchers = {
  // --- SPAIN ---
  marca: async () => trySources([
    'https://www.frontpages.com/marca/',
    'https://es.kiosko.net/es/np/marca.html'
  ]),
  as: async () => trySources([
    'https://www.frontpages.com/as/',
    'https://es.kiosko.net/es/np/as.html'
  ]),
  mundodeportivo: async () => trySources([
    'https://www.frontpages.com/mundo-deportivo/',
    'https://es.kiosko.net/es/np/mundo_deportivo.html'
  ]),
  sport: async () => trySources([
    'https://www.frontpages.com/sport-es/',
    'https://es.kiosko.net/es/np/sport.html'
  ]),
  estadiodeportivo: async () => trySources([
    'https://www.frontpages.com/estadio-deportivo/',
    'https://es.kiosko.net/es/np/estadio_deportivo.html'
  ]),
  superdeporte: async () => trySources([
    'https://www.frontpages.com/superdeporte/',
    'https://es.kiosko.net/es/np/superdeporte.html'
  ]),
  lesportiu: async () => trySources([
    'https://www.frontpages.com/l-esportiu/',
    'https://es.kiosko.net/es/np/lesportiu.html'
  ]),

  // --- ITALY ---
  gazzetta: async () => trySources([
    'https://www.frontpages.com/la-gazzetta-dello-sport/',
    'https://it.kiosko.net/it/np/gazzetta_sport.html'
  ]),
  corrieredellosport: async () => trySources([
    'https://www.frontpages.com/corriere-dello-sport/',
    'https://it.kiosko.net/it/np/corriere_sport.html'
  ]),
  tuttosport: async () => trySources([
    'https://www.frontpages.com/tuttosport/',
    'https://it.kiosko.net/it/np/tuttosport.html'
  ]),

  // --- FRANCE ---
  lequipe: async () => trySources([
    'https://www.frontpages.com/l-equipe/',
    'https://fr.kiosko.net/fr/np/lequipe.html'
  ]),

  // --- PORTUGAL ---
  abola: async () => trySources([
    'https://www.frontpages.com/a-bola/',
    'https://pt.kiosko.net/pt/np/abola.html'
  ]),
  record: async () => trySources([
    'https://www.frontpages.com/record/',
    'https://pt.kiosko.net/pt/np/record.html'
  ]),
  ojogo: async () => trySources([
    'https://www.frontpages.com/o-jogo/',
    'https://pt.kiosko.net/pt/np/ojogo.html'
  ]),

  // --- UK ---
  mirrorsport: async () => trySources([
    'https://www.frontpages.com/daily-mirror-sport/',
    'https://uk.kiosko.net/uk/np/mirror_sport.html'
  ]),
  sun: async () => trySources([
    'https://www.frontpages.com/the-sun-sport/',
    'https://uk.kiosko.net/uk/np/sun_sport.html'
  ]),
  dailymail: async () => trySources([
    'https://www.frontpages.com/daily-mail-sport/',
    'https://uk.kiosko.net/uk/np/daily_mail_sport.html'
  ]),

  // --- GERMANY ---
  kicker: async () => trySources([
    'https://www.frontpages.com/kicker/',
    'https://de.kiosko.net/de/np/kicker.html'
  ]),
  bild: async () => trySources([
    'https://www.frontpages.com/sport-bild/',
    'https://de.kiosko.net/de/np/bild.html'
  ])
};
