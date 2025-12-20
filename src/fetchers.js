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

  // 1. Frontpages.com specific (High Res)
  // They use a specific structure for the main image
  const frontpagesImg = $('.wp-post-image').attr('src');
  if (frontpagesImg) candidates.push(frontpagesImg);

  // 2. Kiosko.net specific
  // They often put the cover in an image with "750" or "portada" in the name
  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    
    if (src.includes('750') || src.includes('portada') || src.includes('front-page')) {
      candidates.push(src);
    }
  });

  // 3. Open Graph (often reliable, but sometimes is a logo)
  const ogImg = $('meta[property="og:image"]').attr('content');
  if (ogImg) candidates.push(ogImg);

  // FILTERING LOGIC
  for (const img of candidates) {
    if (!img) continue;
    
    // Reject known logo patterns
    if (img.includes('logo') || img.includes('icon') || img.includes('avatar')) {
      console.log(`Skipping logo-like image: ${img}`);
      continue;
    }
    
    // Reject tiny images (often tracking pixels or icons)
    // (We can't check dimensions without downloading, but we can check filename hints)
    
    return img; // Return the first non-logo candidate
  }
  
  return null;
}

// Main fetcher function called by build.js
export async function fetchCover(publisher, date, outputDir) {
  const fetcher = fetchers[publisher.id];
  if (!fetcher) throw new Error(`No fetcher for ${publisher.id}`);

  const imageUrl = await fetcher();
  if (!imageUrl) throw new Error('Cover not found after trying all methods');

  // Download the image
  const filename = `${date}-medium.jpg`;
  const filepath = path.join(outputDir, filename);
  
  // Handle relative URLs (Kiosko sometimes uses them)
  const finalUrl = imageUrl.startsWith('http') ? imageUrl : `https://es.kiosko.net${imageUrl}`;
  
  await downloadImage(finalUrl, filepath);
  
  return { localFile: filename, url: finalUrl };
}

export const fetchers = {
  // --- SPAIN ---
  marca: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/marca/',
      'https://es.kiosko.net/es/np/marca.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  as: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/as/',
      'https://es.kiosko.net/es/np/as.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  mundodeportivo: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/mundo-deportivo/',
      'https://es.kiosko.net/es/np/mundo_deportivo.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  sport: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/sport/',
      'https://es.kiosko.net/es/np/sport.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- FRANCE ---
  lequipe: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/lequipe/',
      'https://es.kiosko.net/fr/np/le_equipe.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- ITALY ---
  gazzetta: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/la-gazzetta-dello-sport/',
      'https://es.kiosko.net/it/np/gazzetta_sport.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  corriere: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/corriere-dello-sport/',
      'https://es.kiosko.net/it/np/corriere_sport.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  tuttosport: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/tuttosport/',
      'https://es.kiosko.net/it/np/tuttosport.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- UK ---
  dailystar: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/daily-star-sunday/',
      'https://es.kiosko.net/uk/np/daily_star.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  mirror: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/sunday-mirror/',
      'https://es.kiosko.net/uk/np/mirror.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- PORTUGAL ---
  abola: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/a-bola/',
      'https://es.kiosko.net/pt/np/abola.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  record: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/record/',
      'https://es.kiosko.net/pt/np/record.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  ojogo: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/o-jogo/',
      'https://es.kiosko.net/pt/np/ojogo.html'
    ]);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  }
};
