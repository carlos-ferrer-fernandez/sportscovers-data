import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchWithFallback(urls) {
  for (const url of urls) {
    try {
      console.log(`Trying to fetch: ${url}`);
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
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

// Helper to find the biggest image in Kiosko/Frontpages
function findBestCoverImage($, html) {
  // Strategy 1: Kiosko.net main image
  let img = $('img[src*="portada"]').attr('src');
  
  // Strategy 2: Frontpages.com main image
  if (!img) img = $('img[src*="front-page"]').attr('src');
  
  // Strategy 3: Generic "big image" in a cover container
  if (!img) img = $('.main-cover img').attr('src');
  
  return img;
}

export const fetchers = {
  // --- SPAIN ---
  marca: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/es/np/marca.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  as: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/es/np/as.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  mundodeportivo: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/es/np/mundo_deportivo.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  sport: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/es/np/sport.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- FRANCE ---
  lequipe: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/fr/np/le_equipe.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- ITALY ---
  gazzetta: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/it/np/gazzetta_sport.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  corriere: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/it/np/corriere_sport.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  tuttosport: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/it/np/tuttosport.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- UK ---
  dailystar: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/uk/np/daily_star.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  mirror: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/uk/np/mirror.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  // --- PORTUGAL ---
  abola: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/pt/np/abola.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  record: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/pt/np/record.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  },

  ojogo: async () => {
    const { html, success } = await fetchWithFallback(['https://es.kiosko.net/pt/np/ojogo.html']);
    if (!success) return null;
    return findBestCoverImage(cheerio.load(html));
  }
};
