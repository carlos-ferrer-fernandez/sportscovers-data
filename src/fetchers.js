import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const http = axios.create({
  timeout: 25000,
  maxRedirects: 5,
  headers: {
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
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
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = e?.response?.status;
      const retriable =
        !status || status === 429 || (status >= 500 && status <= 599);
      if (!retriable || i === tries - 1) break;
      await sleep(baseDelayMs * Math.pow(2, i));
    }
  }
  throw last;
}

function normalizeUrl(raw, baseUrl) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  try {
    return new URL(s, baseUrl).href;
  } catch {
    return null;
  }
}

function pickBestFromSrcset(srcset, baseUrl) {
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
    return parts.at(-1)?.url || null;
  } catch {
    return null;
  }
}

async function probeImage(url, referer) {
  // Avoid HEAD. Range GET is more reliable across CDNs.
  const res = await withRetry(
    () =>
      http.get(url, {
        responseType: "arraybuffer",
        headers: {
          ...(referer ? { Referer: referer } : {}),
          Range: "bytes=0-32768",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        validateStatus: (s) => s === 200 || s === 206,
      }),
    { tries: 3, baseDelayMs: 500 }
  );

  const ct = String(res.headers["content-type"] || "").toLowerCase();
  if (!ct.startsWith("image/")) throw new Error(`Not an image (ct=${ct})`);
  return { contentType: ct };
}

function extFromContentType(contentType) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (ct === "image/jpeg") return ".jpg";
  if (ct === "image/png") return ".png";
  if (ct === "image/webp") return ".webp";
  if (ct === "image/avif") return ".avif";
  return ".jpg";
}

async function downloadImage(url, filepath, referer) {
  const res = await withRetry(
    () =>
      http.get(url, {
        responseType: "stream",
        headers: {
          ...(referer ? { Referer: referer } : {}),
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        validateStatus: (s) => s === 200,
      }),
    { tries: 3, baseDelayMs: 650 }
  );

  const ct = String(res.headers["content-type"] || "").toLowerCase();
  if (!ct.startsWith("image/")) throw new Error(`Download not image (ct=${ct})`);

  await pipeline(res.data, fs.createWriteStream(filepath));

  const stat = fs.statSync(filepath);
  if (stat.size < 10_000) throw new Error(`Downloaded too small (${stat.size})`);

  return { contentType: ct };
}

/* --------------------------
   Frontpages.com
-------------------------- */

function extractImageCandidates($, pageUrl) {
  const out = new Set();

  // meta candidates
  [
    "meta[property='og:image']",
    "meta[property='og:image:url']",
    "meta[name='twitter:image']",
    "meta[name='twitter:image:src']",
    "link[rel='image_src']",
  ].forEach((sel) => {
    const v = $(sel).attr("content") || $(sel).attr("href");
    const u = normalizeUrl(v, pageUrl);
    if (u) out.add(u);
  });

  // common image nodes
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
      const img = $(el);
      const srcset = img.attr("srcset");
      if (srcset) {
        const best = pickBestFromSrcset(srcset, pageUrl);
        if (best) out.add(best);
      }
      for (const a of ["src", "data-src", "data-lazy-src", "data-original"]) {
        const u = normalizeUrl(img.attr(a), pageUrl);
        if (u) out.add(u);
      }
      const href = normalizeUrl(img.parent("a").attr("href"), pageUrl);
      if (href && /\.(jpe?g|png|webp)(\?|$)/i.test(href)) out.add(href);
    });
    if (out.size > 8) break;
  }

  return [...out].filter((u) => {
    const lu = u.toLowerCase();
    if (lu.includes("placeholder") || lu.includes("logo")) return false;
    return true;
  });
}

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

    const candidates = extractImageCandidates($, pageUrl).sort((a, b) => {
      const score = (u) => {
        const lu = u.toLowerCase();
        let s = 0;
        if (lu.includes("wp-content/uploads")) s += 10;
        if (lu.includes("cover") || lu.includes("frontpage")) s += 5;
        if (/\b(1500|2000|1200|1024)\b/.test(lu)) s += 3;
        if (lu.includes(".jpg")) s += 2;
        return s;
      };
      return score(b) - score(a);
    });

    for (const imgUrl of candidates) {
      try {
        await probeImage(imgUrl, pageUrl);
        return { url: imgUrl, referer: pageUrl, source: "frontpages.com" };
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

/* --------------------------
   Kiosko.net (best for date-based)
-------------------------- */

const KIOSKO_MAP = {
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
  // kicker: ??? (not sure kiosko has it; leave out unless confirmed)
};

async function fetchKioskoNetFromDailyHtml(publisherId, dateStr) {
  const pathKey = KIOSKO_MAP[publisherId];
  if (!pathKey) return null;

  const [lang, paper] = pathKey.split("/");
  const dayUrl = `https://${lang}.kiosko.net/${dateStr}/`;

  const { data } = await withRetry(() => http.get(dayUrl), {
    tries: 3,
    baseDelayMs: 700,
  });
  const $ = cheerio.load(data);

  // Prefer explicit tile img for that paper
  let imgUrl =
    normalizeUrl($(`img[src*="/${pathKey}."]`).first().attr("src"), dayUrl) ||
    normalizeUrl($(`img[data-src*="/${pathKey}."]`).first().attr("data-src"), dayUrl);

  // Or from link tile
  if (!imgUrl) {
    const a = $(`a[href$="${paper}.html"]`).first();
    if (a.length) {
      const img = a.find("img").first();
      imgUrl =
        pickBestFromSrcset(img.attr("srcset") || "", dayUrl) ||
        normalizeUrl(img.attr("src") || img.attr("data-src"), dayUrl);
    }
  }

  if (!imgUrl) return null;

  await probeImage(imgUrl, dayUrl);
  return { url: imgUrl, referer: dayUrl, source: "kiosko.net(html)" };
}

async function fetchKioskoNetDirect(publisherId, dateStr) {
  const pathKey = KIOSKO_MAP[publisherId];
  if (!pathKey) return null;

  const [year, month, day] = dateStr.split("-");
  const base = `https://img.kiosko.net/${year}/${month}/${day}/${pathKey}`;
  const sizes = ["1500", "1000", "750", "500", "300"];

  for (const size of sizes) {
    const url = `${base}.${size}.jpg`;
    try {
      await probeImage(url, null);
      return { url, referer: null, source: "kiosko.net(direct)" };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fetchKioskoNet(publisherId, dateStr) {
  try {
    return (
      (await fetchKioskoNetFromDailyHtml(publisherId, dateStr)) ||
      (await fetchKioskoNetDirect(publisherId, dateStr))
    );
  } catch {
    return null;
  }
}

/* --------------------------
   Generic meta / DOM scan
-------------------------- */

async function fetchMetaImage(pageUrl, selectors = []) {
  const { data } = await withRetry(() => http.get(pageUrl), {
    tries: 3,
    baseDelayMs: 700,
  });
  const $ = cheerio.load(data);

  const defaults = [
    "meta[property='og:image']",
    "meta[property='og:image:url']",
    "meta[name='twitter:image']",
    "meta[name='twitter:image:src']",
    "link[rel='image_src']",
  ];

  for (const sel of [...selectors, ...defaults]) {
    const el = $(sel).first();
    if (!el.length) continue;
    const raw = el.attr("content") || el.attr("href");
    const u = normalizeUrl(raw, pageUrl);
    if (!u) continue;
    await probeImage(u, pageUrl);
    return { url: u, referer: pageUrl, source: "meta" };
  }
  return null;
}

async function fetchDomScan(pageUrl, selector) {
  const { data } = await withRetry(() => http.get(pageUrl), {
    tries: 3,
    baseDelayMs: 700,
  });
  const $ = cheerio.load(data);

  const node = $(selector).first();
  if (!node.length) return null;

  let imgUrl =
    pickBestFromSrcset(node.attr("srcset") || "", pageUrl) ||
    normalizeUrl(
      node.attr("src") ||
        node.attr("data-src") ||
        node.attr("data-lazy-src") ||
        node.attr("data-original"),
      pageUrl
    );

  // Sometimes the image is in the parent link
  if (!imgUrl) {
    imgUrl = normalizeUrl(node.parent("a").attr("href"), pageUrl);
  }

  if (!imgUrl) return null;
  await probeImage(imgUrl, pageUrl);
  return { url: imgUrl, referer: pageUrl, source: "dom:page_scan" };
}

/* --------------------------
   X/Twitter fallback via Nitter (best-effort)
   NOTE: Nitter instances can be unreliable; keep as optional fallback.
-------------------------- */

function twitterHandleFromUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("twitter.com") && !u.hostname.includes("x.com")) return null;
    const handle = u.pathname.split("/").filter(Boolean)[0];
    return handle || null;
  } catch {
    return null;
  }
}

async function fetchLatestMediaFromNitter(nitterProfileUrl) {
  // Use RSS: easier to parse, less HTML churn
  const rssUrl = nitterProfileUrl.replace(/\/+$/, "") + "/rss";
  const { data } = await withRetry(
    () => http.get(rssUrl, { headers: { Accept: "application/rss+xml,text/xml,*/*" } }),
    { tries: 2, baseDelayMs: 700 }
  );

  const $ = cheerio.load(data, { xmlMode: true });
  const item = $("item").first();
  if (!item.length) return null;

  // Prefer enclosure if present
  const enc = item.find("enclosure").attr("url");
  const encUrl = normalizeUrl(enc, rssUrl);
  if (encUrl) {
    await probeImage(encUrl, nitterProfileUrl);
    return { url: encUrl, referer: nitterProfileUrl, source: "nitter(rss)" };
  }

  // Or parse HTML in description for img
  const desc = item.find("description").text() || "";
  const $$ = cheerio.load(desc);
  const img = $$("img").first().attr("src");
  const imgUrl = normalizeUrl(img, nitterProfileUrl);
  if (imgUrl) {
    await probeImage(imgUrl, nitterProfileUrl);
    return { url: imgUrl, referer: nitterProfileUrl, source: "nitter(desc)" };
  }

  return null;
}

/* --------------------------
   MAIN
-------------------------- */

function resolveAlias(publisher, publishersById) {
  if (publisher.type === "alias" && publisher.aliasOf) {
    return publishersById.get(publisher.aliasOf) || publisher;
  }
  return publisher;
}

async function fetchFromPrimary(publisher) {
  const { primary } = publisher;
  if (!primary?.url || !primary?.method) return null;

  if (primary.method === "og:image") {
    return fetchMetaImage(primary.url, [primary.selector].filter(Boolean));
  }
  if (primary.method === "dom:page_scan") {
    return fetchDomScan(primary.url, primary.selector);
  }
  if (primary.method === "social:x_latest_media") {
    // Prefer explicit nitter_proxy fallback if provided, else derive from twitter url.
    const nitter = (publisher.fallbacks || []).find((f) => f.type === "nitter_proxy")?.url;
    const profileUrl = nitter || primary.url?.replace("twitter.com", "nitter.net").replace("x.com", "nitter.net");
    if (profileUrl && profileUrl.includes("nitter.net")) {
      return fetchLatestMediaFromNitter(profileUrl);
    }
    return null;
  }

  return null;
}

async function fetchFromFallbacks(publisher) {
  for (const fb of publisher.fallbacks || []) {
    if (fb.type === "site") {
      const r = await fetchMetaImage(fb.url);
      if (r) return r;
    }
    if (fb.type === "nitter_proxy") {
      const r = await fetchLatestMediaFromNitter(fb.url);
      if (r) return r;
    }
  }
  return null;
}

export async function fetchCover(publisher, dateStr, outputDir, allPublishers = []) {
  const publishersById = new Map(allPublishers.map((p) => [p.id, p]));
  publisher = resolveAlias(publisher, publishersById);

  // Order tuned for “maximum hit rate” + date correctness
  let result =
    (await fetchKioskoNet(publisher.id, dateStr)) ||
    (await fetchFrontpagesCom(publisher.id)) ||
    (await fetchFromPrimary(publisher)) ||
    (await fetchFromFallbacks(publisher));

  if (!result?.url) {
    throw new Error(`Cover not found for ${publisher.id}`);
  }

  const urlExt = path.extname(result.url.split("?")[0] || "");
  const tmpPath = path.join(outputDir, `${dateStr}-medium${urlExt || ".img"}`);

  const { contentType } = await downloadImage(result.url, tmpPath, result.referer);

  const finalExt = urlExt || extFromContentType(contentType);
  const finalFilename = `${dateStr}-medium${finalExt}`;
  const finalPath = path.join(outputDir, finalFilename);

  if (tmpPath !== finalPath) fs.renameSync(tmpPath, finalPath);

  return { url: result.url, localFile: finalFilename, source: result.source };
}