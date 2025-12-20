import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Configure axios defaults
axios.defaults.headers.common['User-Agent'] = USER_AGENT;

// Helper to download image
async function downloadImage(url, filepath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    validateStatus: status => status === 200
  });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Fetchers for different methods
const fetchers = {
  'og:image': async (url, selector) => {
    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);
      // Default selector for og:image if not provided
      const sel = selector || "meta[property='og:image']";
      const imageUrl = $(sel).attr('content');
      if (imageUrl) return imageUrl;
      throw new Error('og:image not found');
    } catch (e) {
      console.error(`    og:image failed for ${url}: ${e.message}`);
      return null;
    }
  },
  'dom:page_scan': async (url, selector) => {
    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);
      const img = $(selector).first();
      let imageUrl = img.attr('src') || img.attr('data-src') || img.attr('srcset');
      
      // Handle srcset (take the last/largest one)
      if (imageUrl && imageUrl.includes(',')) {
        imageUrl = imageUrl.split(',').pop().trim().split(' ')[0];
      }

      // Handle relative URLs
      if (imageUrl && !imageUrl.startsWith('http')) {
        const baseUrl = new URL(url).origin;
        imageUrl = new URL(imageUrl, baseUrl).href;
      }
      
      if (imageUrl) return imageUrl;
      throw new Error('dom:page_scan image not found');
    } catch (e) {
      console.error(`    dom:page_scan failed for ${url}: ${e.message}`);
      return null;
    }
  },
  'social:x_latest_media': async (url) => {
    // Placeholder: In a real env, this would use Puppeteer or Twitter API
    // For this static scraper, we can't easily scrape X without auth
    console.log(`    social:x_latest_media skipped for ${url} (requires auth)`);
    return null;
  },
  'site': async (url) => {
    // Generic fallback: try to find og:image on the main site
    return fetchers['og:image'](url, "meta[property='og:image']");
  },
  'none': async () => null
};

export async function fetchCover(publisher, dateStr, outputDir) {
  let imageUrl = null;

  // 1. Try Primary Method
  console.log(`  Trying primary: ${publisher.primary.method} on ${publisher.primary.url}`);
  if (fetchers[publisher.primary.method]) {
    imageUrl = await fetchers[publisher.primary.method](
      publisher.primary.url, 
      publisher.primary.selector
    );
  }

  // 2. Try Fallbacks if primary failed
  if (!imageUrl && publisher.fallbacks) {
    for (const fallback of publisher.fallbacks) {
      console.log(`  Trying fallback: ${fallback.type} on ${fallback.url}`);
      
      // Map fallback types to fetcher methods
      let method = 'none';
      if (fallback.type === 'site') method = 'site';
      else if (fallback.type === 'x_profile') method = 'social:x_latest_media';
      
      if (fetchers[method]) {
        imageUrl = await fetchers[method](fallback.url);
        if (imageUrl) break; // Found one!
      }
    }
  }

  if (imageUrl) {
    const ext = path.extname(imageUrl).split('?')[0] || '.jpg';
    const filename = `${dateStr}-medium${ext}`;
    const filepath = path.join(outputDir, filename);
    
    await downloadImage(imageUrl, filepath);
    return {
      url: imageUrl,
      localFile: filename
    };
  }

  throw new Error('Cover not found after trying all methods');
}
