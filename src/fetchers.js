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
          'Cookie': 'euconsent-v2=ACCEPTED', // Try to bypass GDPR popup
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

// Helper to find the biggest image
function findBestCoverImage($, html) {
  // 1. Try Open Graph (Most reliable for direct sites)
  let img = $('meta[property="og:image"]').attr('content');
  
  // 2. Try Kiosko specific structure (ignoring popup)
  if (!img) img = $('img[src*="portada"]').attr('src');
  if (!img) img = $('img[src*="750"]').attr('src'); // Kiosko often uses 750px width in filename
  
  // 3. Try Frontpages.com structure
  if (!img) img = $('.wp-post-image').attr('src');
  
  return img;
}

export const fetchers = {
  // --- SPAIN ---
  marca: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/marca/', // No popup, very clean
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
