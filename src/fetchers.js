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
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });
      
      if (response.ok) {
        const html = await response.text();
        return { html, url, success: true };
      }
      console.log(`Failed to fetch ${url}: ${response.status}`);
    } catch (error) {
      console.log(`Error fetching ${url}: ${error.message}`);
    }
  }
  return { success: false };
}

export const fetchers = {
  // --- SPAIN ---
  marca: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.marca.com/primer-plano/portada.html',
      'https://es.kiosko.net/es/np/marca.html' // Reliable backup
    ]);
    if (!success) return null;
    
    const $ = cheerio.load(html);
    // Try direct Marca structure
    let img = $('.main-cover img').attr('src') || $('.cover-image').attr('src');
    // Try Open Graph
    if (!img) img = $('meta[property="og:image"]').attr('content');
    // Try Kiosko structure
    if (!img) img = $('img[src*="portada"]').attr('src');
    
    return img;
  },

  as: async () => {
    const { html, success } = await fetchWithFallback([
      'https://as.com/noticias/portada/',
      'https://es.kiosko.net/es/np/as.html'
    ]);
    if (!success) return null;
    
    const $ = cheerio.load(html);
    let img = $('meta[property="og:image"]').attr('content');
    if (!img) img = $('.portada-img img').attr('src');
    if (!img) img = $('img[src*="portada"]').attr('src'); // Kiosko fallback
    
    return img;
  },

  mundodeportivo: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.mundodeportivo.com/primer-plano/portada.html',
      'https://es.kiosko.net/es/np/mundo_deportivo.html'
    ]);
    if (!success) return null;
    
    const $ = cheerio.load(html);
    let img = $('.cover-image img').attr('src');
    if (!img) img = $('meta[property="og:image"]').attr('content');
    if (!img) img = $('img[src*="portada"]').attr('src');
    
    return img;
  },

  sport: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.sport.es/es/primer-plano/portada.html',
      'https://es.kiosko.net/es/np/sport.html'
    ]);
    if (!success) return null;
    
    const $ = cheerio.load(html);
    let img = $('.cover img').attr('src');
    if (!img) img = $('meta[property="og:image"]').attr('content');
    if (!img) img = $('img[src*="portada"]').attr('src');
    
    return img;
  },

  // --- FRANCE ---
  lequipe: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.lequipe.fr/journal/la-une',
      'https://es.kiosko.net/fr/np/le_equipe.html'
    ]);
    if (!success) return null;
    
    const $ = cheerio.load(html);
    let img = $('.une-container img').attr('src');
    if (!img) img = $('meta[property="og:image"]').attr('content');
    if (!img) img = $('img[src*="portada"]').attr('src');
    
    return img;
  },

  // --- ITALY ---
  gazzetta: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.gazzetta.it/',
      'https://es.kiosko.net/it/np/gazzetta_sport.html'
    ]);
    if (!success) return null;
    
    const $ = cheerio.load(html);
    // Gazzetta is tricky, often Kiosko is better for the full cover
    let img = $('img[src*="portada"]').attr('src'); 
    if (!img) img = $('meta[property="og:image"]').attr('content');
    
    return img;
  },

  corriere: async () => {
    const { html, success } = await fetchWithFallback([
      'https://es.kiosko.net/it/np/corriere_sport.html' // Direct to Kiosko is safer for this one
    ]);
    if (!success) return null;
    const $ = cheerio.load(html);
    return $('img[src*="portada"]').attr('src');
  },

  tuttosport: async () => {
    const { html, success } = await fetchWithFallback([
      'https://es.kiosko.net/it/np/tuttosport.html'
    ]);
    if (!success) return null;
    const $ = cheerio.load(html);
    return $('img[src*="portada"]').attr('src');
  },

  // --- UK ---
  dailystar: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/daily-star-sunday/', // Good source for UK
      'https://es.kiosko.net/uk/np/daily_star.html'
    ]);
    if (!success) return null;
    const $ = cheerio.load(html);
    return $('img[src*="front-page"]').attr('src') || $('img[src*="portada"]').attr('src');
  },

  mirror: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.frontpages.com/sunday-mirror/',
      'https://es.kiosko.net/uk/np/mirror.html'
    ]);
    if (!success) return null;
    const $ = cheerio.load(html);
    return $('img[src*="front-page"]').attr('src') || $('img[src*="portada"]').attr('src');
  },

  // --- PORTUGAL ---
  abola: async () => {
    const { html, success } = await fetchWithFallback([
      'https://www.abola.pt/',
      'https://es.kiosko.net/pt/np/abola.html'
    ]);
    if (!success) return null;
    const $ = cheerio.load(html);
    let img = $('img[src*="portada"]').attr('src');
    if (!img) img = $('meta[property="og:image"]').attr('content');
    return img;
  },

  record: async () => {
    const { html, success } = await fetchWithFallback([
      'https://es.kiosko.net/pt/np/record.html'
    ]);
    if (!success) return null;
    const $ = cheerio.load(html);
    return $('img[src*="portada"]').attr('src');
  },

  ojogo: async () => {
    const { html, success } = await fetchWithFallback([
      'https://es.kiosko.net/pt/np/ojogo.html'
    ]);
    if (!success) return null;
    const $ = cheerio.load(html);
    return $('img[src*="portada"]').attr('src');
  }
};
