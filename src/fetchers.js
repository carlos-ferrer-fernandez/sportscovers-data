import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const http = axios.create({
  timeout: 25000,
  maxRedirects: 5,
  headers: {
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8,fr;q=0.8,it;q=0.8,pt;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  },
  validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { tries = 3, baseDelayMs = 650 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const retriable =
        !status || status === 429 || (status >= 500 && status <= 599);
      if (!retriable || i === tries - 1) break;
      await sleep(baseDelayMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function normalizeUrl(raw, baseUrl) {
  if (!raw) return null;
  const s = raw.trim();

  // protocol-relative: //img.kiosko.net/...
  if (s.startsWith("//")) return "https:" + s;

  // already absolute
  if (s.startsWith("http://") || s.startsWith("https://")) return s;

  // relative
  try {
    return new URL(s, baseUrl).href;
  } catch {
    return null;
  }
}

function pickBestFromSrcset(srcset, baseUrl) {
  // srcset format: "url 300w, url2 1024w" or "url 1x, url2 2x"
  try {
    const parts = srcset
      .split(",")
      .map((p) => p.trim())
      .map((p) => {
        const [u, d] = p.split(/\s+/);
        const desc = (d || "").trim();
        const score = desc.endsWith("w")
          ? parseInt(desc.slice(0, -1), 10)
          : desc.endsWith("x")
          ? parseFloat(desc.slice(0, -1)) * 1000
          : 0;
        return { url: normalizeUrl(u, baseUrl), score: Number(score) || 0 };
      })
      .filter((x) => x.url);

    parts.sort((a, b) => a.score - b.score);
    return parts.length ? parts[parts.length - 1].url : null;
  } catch {
    return null;
  }
}

function extractImageCandidates($, pageUrl) {
  const candidates = new Set();

  // Meta tags
  [
    "meta[property='og:image']",
    "meta[property='og:image:url']",
    "meta[name='twitter:image']",
    "meta[name='twitter:image:src']",
    "link[rel='image_src']",
  ].forEach((sel) => {
    const v = $(sel).attr("content") || $(sel).attr("href");
    const u = normalizeUrl(v, pageUrl);
    if (u) candidates.add(u);
  });

  // JSON-LD (sometimes includes image)
  $("script[type='application/ld+json']").each((_, el) => {
    const txt = $(el).text();
    if (!txt) return;
    try {
      const json = JSON.parse(txt);
      const items = Array.isArray(json) ? json : [json];
      for (const it of items) {
        const img = it?.image;
        if (typeof img === "string") {
          const u = normalizeUrl(img, pageUrl);
          if (u) candidates.add(u);
        } else if (Array.isArray(img)) {
          for (const x of img) {
            const u = normalizeUrl(x, pageUrl);
            if (u) candidates.add(u);
          }
        } else if (img?.url) {
          const u = normalizeUrl(img.url, pageUrl);
          if (u) candidates.add(u);
        }
      }
    } catch {
      /* ignore */
    }
  });

  // Common “main image” selectors (frontpages often uses WP classes)
  const imgSelectors = [
    "img.attachment-full",
    "img.attachment-large",
    "img.wp-post-image",
    "article img",
    "figure img",
    "main img",
  ];

  for (const sel of imgSelectors) {
    $(sel).each((_, el) => {
      const $img = $(el);

      const srcset = $img.attr("srcset");
      if (srcset) {
        const best = pickBestFromSrcset(srcset, pageUrl);
        if (best) candidates.add(best);
      }

      const attrs = [
        "src",
        "data-src",
        "data-lazy-src",
        "data-original",
        "data-large-image",
      ];
      for (const a of attrs) {
        const v = $img.attr(a);
        const u = normalizeUrl(v, pageUrl);
        if (u) candidates.add(u);
      }

      // Sometimes image is wrapped in <a href="...jpg">
      const href = $img.parent("a").attr("href");
      const uh = normalizeUrl(href, pageUrl);
      if (uh && /\.(jpe?g|png|webp)(\?|$)/i.test(uh)) candidates.add(uh);
    });

    // If we already found meta + main candidates, we can stop early
    if (candidates.size > 6) break;
  }

  // Any direct JPG/PNG links (rare but useful)
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const u = normalizeUrl(href, pageUrl);
    if (u && /\.(jpe?g|png|webp)(\?|$)/i.test(u)) candidates.add(u);
  });

  // Remove obvious placeholders/logos
  const filtered = [...candidates].filter((u) => {
    const lu = u.toLowerCase();
    if (lu.includes("placeholder")) return false;
    if (lu.includes("logo")) return false;
    return true;
  });

  return filtered;
}

async function probeImage(url, referer) {
  // GET with Range avoids big downloads and is more reliable than HEAD on some CDNs
  return withRetry(async () => {
    const res = await http.get(url, {
      responseType: "arraybuffer",
      headers: {
        ...(referer ? { Referer: referer } : {}),
        Range: "bytes=0-32768",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      validateStatus: (s) => s === 200 || s === 206,
    });

    const ct = (res.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("image/")) {
      // Often a block page (text/html) or error response masquerading
      throw new Error(`Not an image content-type (${ct})`);
    }

    return { ok: true, contentType: ct };
  }, { tries: 3, baseDelayMs: 500 });
}

function extFromContentType(contentType) {
  if (!contentType) return null;
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (ct === "image/jpeg") return ".jpg";
  if (ct === "image/png") return ".png";
  if (ct === "image/webp") return ".webp";
  if (ct === "image/avif") return ".avif";
  return null;
}

async function downloadImage(url, filepath, referer) {
  return withRetry(async () => {
    const res = await http.get(url, {
      responseType: "stream",
      headers: {
        ...(referer ? { Referer: referer } : {}),
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      validateStatus: (s) => s === 200,
    });

    const ct = (res.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("image/")) {
      throw new Error(`Download returned non-image content-type (${ct})`);
    }

    await pipeline(res.data, fs.createWriteStream(filepath));

    // Basic sanity check (avoid saving tiny HTML error pages)
    const stat = fs.statSync(filepath);
    if (stat.size < 10_000) {
      throw new Error(`Downloaded file too small (${stat.size} bytes)`);
    }

    return { contentType: ct };
  }, { tries: 3, baseDelayMs: 650 });
}

/* --------------------------
   SOURCE 1: Frontpages.com
-------------------------- */

async function fetchFrontpagesCom(publisherId) {
  const slugMap = {
    marca: "marca",
    as: "as",
    mundodeportivo: "mundo-deportivo",
    sport: "sport",
    lesportiu: "l-esportiu",
    estadiodeportivo: "estadio-deportivo",
    superdeporte: "superdeporte",
    lequipe: "lequipe",
    gazzetta: "la-gazzetta-dello-sport",
    corriere: "corriere-dello-sport",
    tuttosport: "tuttosport",
    abola: "a-bola",
    record: "record",
    ojogo: "o-jogo",
    kicker: "kicker",
    dailystar: "daily-star",
    mirror: "daily-mirror",
    express: "daily-express",
  };

  const slug = slugMap[publisherId] || publisherId;
  const pageUrl = `https://www.frontpages.com/${slug}`;

  try {
    const { data } = await withRetry(() => http.get(pageUrl), {
      tries: 3,
      baseDelayMs: 700,
    });
    const $ = cheerio.load(data);

    const candidates = extractImageCandidates($, pageUrl);

    // Try candidates in order; prefer ones that look like full-size covers
    const sorted = candidates.sort((a, b) => {
      const score = (u) => {
        const lu = u.toLowerCase();
        let s = 0;
        if (lu.includes("wp-content/uploads")) s += 10;
        if (lu.includes("frontpage") || lu.includes("cover")) s += 5;
        if (/\b(1500|2000|1200|1024)\b/.test(lu)) s += 3;
        if (lu.endsWith(".jpg") || lu.includes(".jpg?")) s += 2;
        return s;
      };
      return score(b) - score(a);
    });

    for (const imgUrl of sorted) {
      try {
        await probeImage(imgUrl, pageUrl);
        return { url: imgUrl, referer: pageUrl, source: "frontpages.com" };
      } catch {
        // try next candidate
      }
    }
  } catch (e) {
    console.log(`    Frontpages.com failed: ${e.message}`);
  }

  return null;
}

/* --------------------------
   SOURCE 2: Kiosko.net
   (HTML daily page first, then direct img patterns)
-------------------------- */

function kioskoLangAndPaper(pathKey) {
  // pathKey like "es/marca" => lang "es", paper "marca"
  const [lang, paper] = pathKey.split("/");
  return { lang, paper };
}

async function fetchKioskoNetFromDailyHtml(publisherId, dateStr) {
  const kioskoMap = {
    marca: "es/marca",
    as: "es/as",
    mundodeportivo: "es/mundo_deportivo",
    sport: "es/sport",
    lesportiu: "es/lesportiu",
    estadiodeportivo: "es/estadio_deportivo",
    superdeporte: "es/superdeporte",
    lequipe: "fr/le_equipe",
    gazzetta: "it/gazzetta_sport",
    corriere: "it/corriere_sport",
    tuttosport: "it/tuttosport",
    abola: "pt/abola",
    record: "pt/record",
    ojogo: "pt/ojogo",
    dailystar: "uk/daily_star",
    mirror: "uk/daily_mirror",
    express: "uk/daily_express",
  };

  const pathKey = kioskoMap[publisherId];
  if (!pathKey) return null;

  const { lang, paper } = kioskoLangAndPaper(pathKey);

  // Daily page contains the exact img URL used that day.
  const dayUrl = `https://${lang}.kiosko.net/${dateStr}/`;

  try {
    const { data } = await withRetry(() => http.get(dayUrl), {
      tries: 3,
      baseDelayMs: 700,
    });
    const $ = cheerio.load(data);

    // Strategy A: find img whose src contains "/lang/paper."
    const img1 =
      $(`img[src*="/${pathKey}."]`).first().attr("src") ||
      $(`img[data-src*="/${pathKey}."]`).first().attr("data-src");

    let imageUrl = normalizeUrl(img1, dayUrl);

    // Strategy B: find the anchor to the paper page (paper.html) then image inside that tile
    if (!imageUrl) {
      const a = $(`a[href$="${paper}.html"]`).first();
      if (a.length) {
        const img = a.find("img").first();
        const srcset = img.attr("srcset");
        imageUrl =
          (srcset && pickBestFromSrcset(srcset, dayUrl)) ||
          normalizeUrl(
            img.attr("src") || img.attr("data-src") || null,
            dayUrl
          );
      }
    }

    if (imageUrl) {
      await probeImage(imageUrl, dayUrl);
      return { url: imageUrl, referer: dayUrl, source: "kiosko.net(html)" };
    }
  } catch (e) {
    // ignore, fallback below
  }

  return null;
}

async function fetchKioskoNetDirectImage(publisherId, dateStr) {
  const kioskoMap = {
    marca: "es/marca",
    as: "es/as",
    mundodeportivo: "es/mundo_deportivo",
    sport: "es/sport",
    lesportiu: "es/lesportiu",
    estadiodeportivo: "es/estadio_deportivo",
    superdeporte: "es/superdeporte",
    lequipe: "fr/le_equipe",
    gazzetta: "it/gazzetta_sport",
    corriere: "it/corriere_sport",
    tuttosport: "it/tuttosport",
    abola: "pt/abola",
    record: "pt/record",
    ojogo: "pt/ojogo",
    dailystar: "uk/daily_star",
    mirror: "uk/daily_mirror",
    express: "uk/daily_express",
  };

  const pathKey = kioskoMap[publisherId];
  if (!pathKey) return null;

  const [year, month, day] = dateStr.split("-");

  // Try multiple common sizes; kiosko frequently uses 750 but not always
  const sizes = ["1500", "1000", "750", "500", "300"];
  const base = `https://img.kiosko.net/${year}/${month}/${day}/${pathKey}`;

  for (const size of sizes) {
    const url = `${base}.${size}.jpg`;
    try {
      await probeImage(url, null);
      return { url, referer: null, source: "kiosko.net(direct)" };
    } catch {
      // next size
    }
  }

  // Last try: no size suffix sometimes exists
  const urlNoSize = `${base}.jpg`;
  try {
    await probeImage(urlNoSize, null);
    return { url: urlNoSize, referer: null, source: "kiosko.net(direct)" };
  } catch {
    return null;
  }
}

async function fetchKioskoNet(publisherId, dateStr) {
  // Most reliable first:
  return (
    (await fetchKioskoNetFromDailyHtml(publisherId, dateStr)) ||
    (await fetchKioskoNetDirectImage(publisherId, dateStr))
  );
}

/* --------------------------
   SOURCE 3: Generic page scan
-------------------------- */

async function fetchGenericPage(url, selector) {
  try {
    const { data } = await withRetry(() => http.get(url), {
      tries: 3,
      baseDelayMs: 700,
    });
    const $ = cheerio.load(data);

    // Allow selector to point to meta or img
    const el = $(selector).first();
    if (!el.length) return null;

    let imageUrl =
      el.attr("content") ||
      el.attr("href") ||
      el.attr("src") ||
      el.attr("data-src");

    if (!imageUrl) {
      const srcset = el.attr("srcset");
      if (srcset) imageUrl = pickBestFromSrcset(srcset, url);
    }

    imageUrl = normalizeUrl(imageUrl, url);
    if (!imageUrl) return null;

    await probeImage(imageUrl, url);
    return { url: imageUrl, referer: url, source: "generic" };
  } catch {
    return null;
  }
}

/* --------------------------
   MAIN FETCHER
-------------------------- */

export async function fetchCover(publisher, dateStr, outputDir) {
  let result = null;

  // 1) Kiosko first (date-based and very consistent for Europe)
  result = await fetchKioskoNet(publisher.id, dateStr);

  // 2) Frontpages.com (often “latest”, good fallback)
  if (!result) {
    result = await fetchFrontpagesCom(publisher.id);
  }

  // 3) Publisher custom method
  if (!result && publisher.primary?.method === "dom:page_scan") {
    result = await fetchGenericPage(publisher.primary.url, publisher.primary.selector);
  }

  // 4) Fallbacks (try multiple selectors)
  if (!result && publisher.fallbacks) {
    const selectorsToTry = [
      "meta[property='og:image']",
      "meta[name='twitter:image']",
      "link[rel='image_src']",
      "img",
    ];

    for (const fb of publisher.fallbacks) {
      if (fb.type !== "site") continue;
      for (const sel of selectorsToTry) {
        const res = await fetchGenericPage(fb.url, sel);
        if (res?.url) {
          result = res;
          break;
        }
      }
      if (result) break;
    }
  }

  if (!result?.url) {
    throw new Error("Cover not found after trying all methods");
  }

  // Decide extension more safely
  const urlExt = path.extname(result.url.split("?")[0] || "");
  const tmpExt = urlExt && urlExt.length <= 5 ? urlExt : "";

  const baseFilename = `${dateStr}-medium`;
  const tmpPath = path.join(outputDir, baseFilename + (tmpExt || ".img"));

  const { contentType } = await downloadImage(result.url, tmpPath, result.referer);

  const realExt = tmpExt || extFromContentType(contentType) || ".jpg";
  const finalFilename = baseFilename + realExt;
  const finalPath = path.join(outputDir, finalFilename);

  if (tmpPath !== finalPath) {
    fs.renameSync(tmpPath, finalPath);
  }

  return {
    url: result.url,
    localFile: finalFilename,
    source: result.source,
  };
}