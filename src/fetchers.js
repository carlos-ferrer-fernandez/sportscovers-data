import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function downloadImage(url, filepath) {
  // Fix protocol-relative URLs (e.g. //img.kiosko.net/...)
  if (url.startsWith('//')) {
    url = 'https:' + url;
  }

  console.log(`Downloading image from: ${url}`);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
  await pipeline(response.body, fs.createWriteStream(filepath));
}

async function fetchWithFallback(urls) {
  for (const url of urls) {
    try {
      console.log(`Trying to fetch page: ${url}`);
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

  // 1. Kiosko.net specific (The "Golden Selector")
  const kioskoPortada = $('#portada').attr('src');
  if (kioskoPortada) {
    console.log(`Found Kiosko #portada: ${kioskoPortada}`);
    candidates.push(kioskoPortada);
  }

  // 2. Open Graph (Universal fallback)
  const ogImg = $('meta[property="og:image"]').attr('content');
  if (ogImg) candidates.push(ogImg);

  // 3. Twitter Card Image
  const twitterImg = $('meta[name="twitter:image"]').attr('content');
  if (twitterImg) candidates.push(twitterImg);

  // 4. Frontpages.com specific (ID: giornale-img)
  const giornaleImg = $('#giornale-img').attr('src');
  if (giornaleImg) candidates.push(giornaleImg);

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

// Helper to try multiple sources sequentially
// NOW WITH INTEGRATED DOWNLOAD CHECK
async function trySourcesAndDownload(sources, outputDir, date) {
  const filename = `${date}-medium.jpg`;
  const filepath = path.join(outputDir, filename);

  for (const sourceUrl of sources) {
    console.log(`Attempting source: ${sourceUrl}`);
    const { html, success } = await fetchWithFallback([sourceUrl]);
    
    if (success) {
      const $ = cheerio.load(html);
      const image = findBestCoverImage($, html);
      
      if (image) {
        // CLEANUP: Some sites might return a URL with a trailing dot or weird chars
        let cleanImage = image.trim();
        if (cleanImage.endsWith('.webp.jpg')) {
            cleanImage = cleanImage.slice(0, -4);
        }
        
        console.log(`Found candidate image on ${sourceUrl}: ${cleanImage}`);
        
        // TRY TO DOWNLOAD IMMEDIATELY
        try {
            await downloadImage(cleanImage, filepath);
            console.log(`[SUCCESS] Downloaded cover from ${sourceUrl}`);
            return { localFile: filename, url: cleanImage };
        } catch (err) {
            console.error(`[WARNING] Found image but failed to download: ${err.message}`);
            console.log(`Trying next source...`);
            // Continue to next source in the loop!
        }
      } else {
        console.log(`Page loaded but NO image found on ${sourceUrl}`);
      }
    }
  }
  
  console.error(`[FAILURE] Exhausted all sources. No cover found.`);
  return null;
}

// Main fetcher function called by build.js
export async function fetchCover(publisher, date, outputDir) {
  const fetcher = fetchers[publisher.id];
  if (!fetcher) throw new Error(`No fetcher for ${publisher.id}`);

  // Execute the fetcher logic which now handles multiple sources AND downloading
  return await fetcher(outputDir, date);
}

export const fetchers = {
  // --- SPAIN ---
  marca: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/marca/',
    'https://es.kiosko.net/es/np/marca.html'
  ], dir, date),
  as: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/as/',
    'https://es.kiosko.net/es/np/as.html'
  ], dir, date),
  mundodeportivo: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/mundo-deportivo/',
    'https://es.kiosko.net/es/np/mundo_deportivo.html'
  ], dir, date),
  sport: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/sport-es/',
    'https://es.kiosko.net/es/np/sport.html'
  ], dir, date),
  estadiodeportivo: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/estadio-deportivo/',
    'https://es.kiosko.net/es/np/estadio_deportivo.html'
  ], dir, date),
  superdeporte: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/superdeporte/',
    'https://es.kiosko.net/es/np/superdeporte.html'
  ], dir, date),
  lesportiu: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/l-esportiu/',
    'https://es.kiosko.net/es/np/lesportiu.html'
  ], dir, date),

  // --- ITALY ---
  gazzetta: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/la-gazzetta-dello-sport/',
    'https://it.kiosko.net/it/np/gazzetta_sport.html'
  ], dir, date),
  corrieredellosport: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/corriere-dello-sport/',
    'https://it.kiosko.net/it/np/corriere_sport.html'
  ], dir, date),
  tuttosport: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/tuttosport/',
    'https://it.kiosko.net/it/np/tuttosport.html'
  ], dir, date),

  // --- FRANCE ---
  lequipe: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/l-equipe/',
    'https://fr.kiosko.net/fr/np/lequipe.html'
  ], dir, date),

  // --- PORTUGAL ---
  abola: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/a-bola/',
    'https://pt.kiosko.net/pt/np/abola.html'
  ], dir, date),
  record: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/record/',
    'https://pt.kiosko.net/pt/np/record.html'
  ], dir, date),
  ojogo: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/o-jogo/',
    'https://pt.kiosko.net/pt/np/ojogo.html'
  ], dir, date),

  // --- UK ---
  mirrorsport: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/daily-mirror-sport/',
    'https://uk.kiosko.net/uk/np/mirror_sport.html'
  ], dir, date),
  sun: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/the-sun-sport/',
    'https://uk.kiosko.net/uk/np/sun_sport.html'
  ], dir, date),
  dailymail: async (dir, date) => trySourcesAndDownload([
    'https://www.frontpages.com/daily-mail-sport/',
    'https://uk.kiosko.net/uk/np/daily_mail_sport.html'
  ], dir, date)
};
