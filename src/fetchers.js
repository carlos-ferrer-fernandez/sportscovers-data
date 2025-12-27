// coverScraper.js
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

/**
 * Scrape & download sports newspaper covers (avoid logos/thumbnails).
 *
 * Sources (in practice, most covers come from Kiosko CDN):
 * 1) today.json (your repo truth) -> uses sourceUrl directly
 * 2) kiosko.net direct CDN predictable URL
 * 3) kiosko.net "np" page (#portada)
 * 4) kiosko.net daily page (fuzzy tile match)
 * 5) frontpages.com (golden selectors + json-ld + regex)
 * 6) publisher.primary / publisher.fallbacks
 *
 * Big improvements vs your previous versions:
 * - image probing reads bytes + dimensions (jpg/png/webp) and scores candidates
 * - candidate ranking across ALL sources (not just first that downloads)
 * - today.json uses fixed path (env var) + fallback discovery
 * - stronger HTML fetch headers (consent cookie) + safer filters
 */

const DEBUG = process.env.COVER_SCRAPER_DEBUG === "1";
function debug(...args) {
  if (DEBUG) console.log(...args);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// Try these today.json locations first (you can override with TODAY_JSON_PATH)
const TODAY_JSON_CANDIDATES = [
  process.env.TODAY_JSON_PATH,
  // common repo layouts
  path.resolve(process.cwd(), "docs/data/today.json"),
  path.resolve(process.cwd(), "docs", "data", "today.json"),
  path.resolve(process.cwd(), "data/today.json"),
  // your machine (as last-resort fallback)
  "/Users/carlos/Documents/GitHub/sportscovers-data/docs/data/today.json",
].filter(Boolean);

const http = axios.create({
  timeout: 25000,
  maxRedirects: 5,
  headers: {
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8,fr;q=0.8,it;q=0.8,pt;q=0.8,de;q=0.8",
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
      const retriable = !status || status === 429 || (status >= 500 && status <= 599);
      if (!retriable || i === tries - 1) break;
      await sleep(baseDelayMs * Math.pow(2, i));
    }
  }
  throw last;
}

async function safe(promise) {
  try {
    return await promise;
  } catch (e) {
    return null;
  }
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

function uniqueByUrl(list) {
  const seen = new Set();
  return list.filter((x) => {
    if (!x?.url) return false;
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

async function fetchHtml(url) {
  const { data } = await withRetry(
    () =>
      http.get(url, {
        headers: {
          // Some sites behave better with consent cookie
          Cookie: "euconsent-v2=ACCEPTED",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        },
      }),
    { tries: 3, baseDelayMs: 700 }
  );
  return data;
}

/* --------------------------
   Image probing: bytes + dimensions (jpg/png/webp)
-------------------------- */

function parseContentRangeTotal(cr) {
  const m = String(cr || "").match(/\/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

function getPngSize(buf) {
  if (buf.length < 24) return null;
  const sig = buf.slice(0, 8).toString("hex");
  if (sig !== "89504e470d0a1a0a") return null;
  if (buf.slice(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function getJpegSize(buf) {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    i += 2;

    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    if (i + 2 > buf.length) break;

    const len = buf.readUInt16BE(i);
    if (!len || i + len > buf.length) break;

    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSOF && i + 7 < buf.length) {
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      return { width, height };
    }

    i += len;
  }
  return null;
}

function getWebpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.slice(0, 4).toString("ascii") !== "RIFF") return null;
  if (buf.slice(8, 12).toString("ascii") !== "WEBP") return null;

  for (let i = 12; i + 16 < buf.length; i++) {
    const tag = buf.slice(i, i + 4).toString("ascii");
    if (tag === "VP8X" && i + 14 < buf.length) {
      const w = 1 + (buf[i + 8] | (buf[i + 9] << 8) | (buf[i + 10] << 16));
      const h = 1 + (buf[i + 11] | (buf[i + 12] << 8) | (buf[i + 13] << 16));
      return { width: w, height: h };
    }
  }
  return null;
}

function getImageSizeFromBuffer(contentType, buf) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (ct === "image/png") return getPngSize(buf);
  if (ct === "image/jpeg") return getJpegSize(buf);
  if (ct === "image/webp") return getWebpSize(buf);
  // AVIF parsing omitted; we score AVIF mostly by bytes + URL patterns.
  return null;
}

async function probeImage(url, referer) {
  const res = await withRetry(
    () =>
      http.get(url, {
        responseType: "arraybuffer",
        headers: {
          ...(referer ? { Referer: referer } : {}),
          Range: "bytes=0-65535",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        validateStatus: (s) => s === 200 || s === 206,
      }),
    { tries: 3, baseDelayMs: 500 }
  );

  const ct = String(res.headers["content-type"] || "").toLowerCase();
  if (!ct.startsWith("image/")) throw new Error(`Not an image (ct=${ct})`);
  if (ct.includes("svg")) throw new Error("SVG rejected");

  const buf = Buffer.from(res.data);
  if (buf.length < 8000) throw new Error(`Image probe too small (${buf.length} bytes)`);

  const totalBytes =
    parseContentRangeTotal(res.headers["content-range"]) ||
    (res.headers["content-length"] ? parseInt(res.headers["content-length"], 10) : null);

  const size = getImageSizeFromBuffer(ct, buf) || null;

  return {
    contentType: ct,
    bytes: totalBytes || buf.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

function scoreCoverCandidate(url, meta, source = "") {
  const lu = (url || "").toLowerCase();
  let s = 0;

  // strong preference if candidate came from today.json (your curated truth)
  if (String(source).startsWith("today.json")) s += 200;

  // hard negatives
  const bad = ["logo", "favicon", "sprite", "icon", "avatar", "profile", "ads", "banner", "placeholder"];
  if (bad.some((k) => lu.includes(k))) s -= 200;

  // known good patterns
  if (lu.includes("img.kiosko.net")) s += 120;
  if (lu.includes("wp-content/uploads")) s += 15;
  if (lu.includes("frontpage") || lu.includes("portada") || lu.includes("cover")) s += 10;

  // bytes heuristic
  if (meta?.bytes) {
    if (meta.bytes > 900_000) s += 35;
    else if (meta.bytes > 400_000) s += 25;
    else if (meta.bytes > 150_000) s += 12;
    else if (meta.bytes < 40_000) s -= 20;
  }

  // dimensions heuristic
  if (meta?.width && meta?.height) {
    const w = meta.width;
    const h = meta.height;
    const aspect = w / h;

    // covers usually portrait and reasonably large
    if (w >= 900 && h >= 1200) s += 60;
    else if (w >= 700 && h >= 900) s += 40;
    else if (w >= 500 && h >= 700) s += 20;
    else s -= 30;

    // portrait-ish aspect
    if (aspect >= 0.5 && aspect <= 0.85) s += 40;
    else if (aspect > 1.2) s -= 60; // wide header/logo

    // extra penalty for "tiny" logos
    if (w <= 320 || h <= 320) s -= 100;
  }

  // extension preference
  if (lu.includes(".jpg") || lu.includes(".jpeg")) s += 5;

  return s;
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
  if (ct.includes("svg")) throw new Error("SVG rejected");

  await pipeline(res.data, fs.createWriteStream(filepath));

  const stat = fs.statSync(filepath);
  if (stat.size < 8000) throw new Error(`Downloaded too small (${stat.size})`);

  return { contentType: ct };
}

/* --------------------------
   Generic extraction
-------------------------- */

function extractImageCandidates($, pageUrl, rawHtml = "") {
  const out = new Set();

  // Golden selectors for covers
  const golden = [
    "#giornale-img",
    "img#giornale-img",
    "#portada",
    "img#portada",
    "img#cover",
    "img.cover",
    "img.frontpage",
    "img[class*='cover']",
    "img[id*='cover']",
    "img[class*='front']",
  ];

  for (const sel of golden) {
    const el = $(sel).first();
    if (!el.length) continue;

    const srcset = el.attr("srcset");
    const best = srcset ? pickBestFromSrcset(srcset, pageUrl) : null;
    if (best) out.add(best);

    for (const a of ["src", "data-src", "data-lazy-src", "data-original"]) {
      const u = normalizeUrl(el.attr(a), pageUrl);
      if (u) out.add(u);
    }
  }

  // OG/Twitter/link rel image
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

  // JSON-LD
  $("script[type='application/ld+json']").each((_, el) => {
    const txt = $(el).text() || "";
    try {
      const json = JSON.parse(txt);
      const items = Array.isArray(json) ? json : [json];
      for (const it of items) {
        const img =
          it?.image?.url ||
          it?.image ||
          it?.thumbnailUrl ||
          it?.primaryImageOfPage?.url ||
          it?.mainEntityOfPage?.primaryImageOfPage?.url;
        if (typeof img === "string") {
          const u = normalizeUrl(img, pageUrl);
          if (u) out.add(u);
        }
      }
    } catch {
      // ignore
    }
  });

  // DOM scan
  const imgSelectors = ["article img", "figure img", "main img", "img"];
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
      if (href && /\.(jpe?g|png|webp|avif)(\?|$)/i.test(href)) out.add(href);
    });
  }

  // Regex fallback for embedded URLs
  const matches =
    String(rawHtml).match(/https?:\/\/[^"' )]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"') ]*)?/gi) || [];
  for (const m of matches) {
    const u = normalizeUrl(m, pageUrl);
    if (u) out.add(u);
  }

  // light filter only
  return [...out].filter((u) => {
    const lu = u.toLowerCase();
    if (lu.includes("favicon") || lu.includes("sprite")) return false;
    return true;
  });
}

/* --------------------------
   frontpages.com
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
  const pageUrl = `https://www.frontpages.com/${slug}/`;

  const data = await fetchHtml(pageUrl);
  const $ = cheerio.load(data);

  const candidates = extractImageCandidates($, pageUrl, data);

  let best = null;
  for (const imgUrl of candidates.slice(0, 120)) {
    try {
      const meta = await probeImage(imgUrl, pageUrl);
      const score = scoreCoverCandidate(imgUrl, meta, "frontpages.com");
      if (!best || score > best.score) best = { url: imgUrl, score };
    } catch {
      // ignore
    }
  }

  if (best && best.score >= 55) {
    return { url: best.url, referer: pageUrl, source: "frontpages.com" };
  }
  return null;
}

/* --------------------------
   kiosko.net
-------------------------- */

const KIOSKO_MAP = {
  // Spain
  marca: ["es/marca"],
  as: ["es/as"],
  mundodeportivo: [
    "es/mundodeportivo",     // NEW (current)
    "es/mundo_deportivo",    // old
    "es/mundo-deportivo",    // old
  ],
  sport: ["es/sport"],
  lesportiu: [
    "es/el9",                // NEW (kiosko current for L'Esportiu)
    "es/lesportiu",
    "es/l_esportiu",
    "es/l-esportiu",
  ],
  estadiodeportivo: ["es/estadio_deportivo", "es/estadio-deportivo"],
  superdeporte: ["es/superdeporte", "es/super_deporte"],

  // France
  lequipe: [
    "fr/l_equip",            // NEW (current, truncated)
    "fr/l_equipe",           // sometimes exists
    "fr/lequipe",
    "fr/le_equipe",          // old-ish
  ],

  // Italy
  gazzetta: ["it/gazzetta_sport", "it/gazzetta-dello-sport"],
  corriere: ["it/corriere_sport", "it/corriere-dello-sport"],
  tuttosport: ["it/tuttosport"],

  // Portugal
  abola: ["pt/abola", "pt/a_bola", "pt/a-bola"],
  record: ["pt/record"],
  ojogo: ["pt/ojogo", "pt/o_jogo", "pt/o-jogo"],

  // UK
  dailystar: ["uk/daily_star"],
  mirror: ["uk/daily_mirror"],
  express: ["uk/daily_express"],

  // Germany
  kicker: ["de/kicker"],
};

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const v = String(x || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function buildKioskoPathKeys(publisherId, publisher) {
  // Kiosko uses language-like folder (es/fr/it/pt/uk/de)
  const langByCountry = { ES: "es", FR: "fr", IT: "it", PT: "pt", UK: "uk", DE: "de" };
  const lang = langByCountry[publisher?.country] || "es";

  // 1) Strong: explicit map (including aliases)
  const mapped = KIOSKO_MAP[publisherId] || [];

  // 2) Auto-generate variants from publisherId + publisherName
  const candidates = [];

  // from publisherId
  const pid = normalizeText(publisherId).replace(/\s+/g, "");
  if (pid) {
    candidates.push(pid); // mundodeportivo
    candidates.push(pid.replace(/-/g, "_"));
    candidates.push(pid.replace(/_/g, ""));
  }

  // from publisherName (handles "L'Equipe")
  const pname = normalizeText(publisher?.name || "");
  if (pname) {
    const words = pname.split(" ").filter(Boolean); // e.g. ["l","equipe"]
    if (words.length) {
      candidates.push(words.join("_")); // l_equipe
      candidates.push(words.join(""));  // lequipe
      if (words.length >= 2 && words[0].length === 1) {
        candidates.push(`${words[0]}_${words[1]}`); // l_equipe
        // kiosko sometimes truncates last word: l_equip
        if (words[1].length >= 4) candidates.push(`${words[0]}_${words[1].slice(0, 5)}`); // l_equi (try)
        if (words[1].length >= 4) candidates.push(`${words[0]}_${words[1].slice(0, 5)}p`); // sometimes helps? harmless
        if (words[1].length >= 4) candidates.push(`${words[0]}_${words[1].slice(0, 5)}`); // duplicate safe
        if (words[1].length >= 4) candidates.push(`${words[0]}_${words[1].slice(0, words[1].length - 1)}`); // l_equip
      }
    }
  }

  // Turn slug variants into "lang/slug"
  const generated = uniqueStrings(candidates).map((slug) => `${lang}/${slug}`);

  // Return combined, unique, with mapped first (more reliable)
  return uniqueStrings([...mapped, ...generated]);
}

function scoreMatch(publisher, href, alt) {
  const hay = normalizeText(`${href || ""} ${alt || ""}`);
  const pid = normalizeText(publisher.publisherId || publisher.id || "");
  const pname = normalizeText(publisher.publisherName || publisher.name || "");

  let s = 0;

  if (pid && hay.includes(pid)) s += 10;

  if (pname) {
    const parts = pname.split(" ").filter(Boolean);
    for (const p of parts) {
      if (p.length >= 4 && hay.includes(p)) s += 2;
    }
  }

  if (String(href || "").toLowerCase().endsWith(".html")) s += 1;

  return s;
}

async function fetchKioskoNetDirectByKeys(publisherId, dateStr, publisher) {
  const [year, month, day] = dateStr.split("-");
  const sizes = ["2000", "1500", "1200", "1000", "750", "500", "300"];
  const pathKeys = buildKioskoPathKeys(publisherId, publisher);

  if (!pathKeys.length) return null;

  for (const pathKey of pathKeys) {
    const base = `https://img.kiosko.net/${year}/${month}/${day}/${pathKey}`;
    for (const size of sizes) {
      for (const ext of [".jpg", ".jpeg"]) {
        const url = `${base}.${size}${ext}`;
        try {
          const meta = await probeImage(url, null);
          const score = scoreCoverCandidate(url, meta, "kiosko.net(direct)");
          if (score >= 70) {
            return { url, referer: null, source: "kiosko.net(direct)" };
          }
        } catch {
          // try next
        }
      }
    }
  }

  return null;
}

async function fetchKioskoNetNP(publisherId, publisher) {
  const keys = KIOSKO_MAP[publisherId];
  if (!keys) return null;

  const langByCountry = { ES: "es", FR: "fr", IT: "it", PT: "pt", UK: "uk", DE: "de" };
  const primaryLang = langByCountry[publisher?.country] || "es";

  const npUrls = [];
  for (const k of keys) {
    const last = k.split("/").pop();
    if (!last) continue;
    npUrls.push(`https://${primaryLang}.kiosko.net/${primaryLang}/np/${last}.html`);
    npUrls.push(`https://www.kiosko.net/${primaryLang}/np/${last}.html`);
  }

  for (const pageUrl of npUrls) {
    const data = await fetchHtml(pageUrl);
    const $ = cheerio.load(data);

    const portada = normalizeUrl($("#portada").attr("src"), pageUrl);
    if (portada) {
      try {
        const meta = await probeImage(portada, pageUrl);
        const score = scoreCoverCandidate(portada, meta, "kiosko.net(np:#portada)");
        if (score >= 70) return { url: portada, referer: pageUrl, source: "kiosko.net(np:#portada)" };
      } catch {
        // continue
      }
    }

    const imgs = extractImageCandidates($, pageUrl, data);
    let best = null;
    for (const imgUrl of imgs.slice(0, 80)) {
      try {
        const meta = await probeImage(imgUrl, pageUrl);
        const score = scoreCoverCandidate(imgUrl, meta, "kiosko.net(np-scan)");
        if (!best || score > best.score) best = { url: imgUrl, score };
      } catch {}
    }
    if (best && best.score >= 70) {
      return { url: best.url, referer: pageUrl, source: "kiosko.net(np-scan)" };
    }
  }

  return null;
}

async function fetchKioskoNetFromDailyHtmlAny(publisher, dateStr) {
  const langByCountry = { ES: "es", FR: "fr", IT: "it", PT: "pt", UK: "uk", DE: "de" };
  const primaryLang = langByCountry[publisher.country] || "es";

  const dayUrls = [
    `https://${primaryLang}.kiosko.net/${dateStr}/`,
    `https://www.kiosko.net/${primaryLang}/${dateStr}/`,
  ];

  for (const dayUrl of dayUrls) {
    const data = await fetchHtml(dayUrl);
    const $ = cheerio.load(data);

    const tiles = [];
    $("a[href$='.html']").each((_, el) => {
      const a = $(el);
      const href = a.attr("href") || "";
      const img = a.find("img").first();
      if (!img.length) return;

      const alt = img.attr("alt") || img.attr("title") || a.text() || "";
      const srcset = img.attr("srcset") || "";
      const src = img.attr("src") || img.attr("data-src") || "";

      const imgUrl = pickBestFromSrcset(srcset, dayUrl) || normalizeUrl(src, dayUrl);
      if (!imgUrl) return;

      tiles.push({ href, alt, imgUrl, dayUrl });
    });

    if (!tiles.length) continue;

    tiles.sort((t1, t2) => {
      const s1 = scoreMatch({ publisherId: publisher.id, publisherName: publisher.name }, t1.href, t1.alt);
      const s2 = scoreMatch({ publisherId: publisher.id, publisherName: publisher.name }, t2.href, t2.alt);
      return s2 - s1;
    });

    for (const t of tiles.slice(0, 10)) {
      const matchScore = scoreMatch({ publisherId: publisher.id, publisherName: publisher.name }, t.href, t.alt);
      if (matchScore < 6) continue;

      try {
        const meta = await probeImage(t.imgUrl, dayUrl);
        const score = scoreCoverCandidate(t.imgUrl, meta, "kiosko.net(daily-html)");
        if (score >= 70) {
          return { url: t.imgUrl, referer: dayUrl, source: "kiosko.net(daily-html)" };
        }
      } catch {
        // next tile
      }
    }
  }

  return null;
}

async function fetchKioskoNet(publisherId, dateStr, publisher) {
  const direct = await safe(fetchKioskoNetDirectByKeys(publisherId, dateStr, publisher));
  if (direct) return direct;

  const np = publisher ? await safe(fetchKioskoNetNP(publisherId, publisher)) : null;
  if (np) return np;

  const daily = publisher ? await safe(fetchKioskoNetFromDailyHtmlAny(publisher, dateStr)) : null;
  if (daily) return daily;

  return null;
}

/* --------------------------
   Generic meta / DOM scan (publisher.primary + fallbacks)
-------------------------- */

async function fetchMetaImage(pageUrl, selectors = []) {
  const data = await fetchHtml(pageUrl);
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

    try {
      const meta = await probeImage(u, pageUrl);
      const score = scoreCoverCandidate(u, meta, "meta");
      if (score >= 70) return { url: u, referer: pageUrl, source: "meta" };
    } catch {
      // ignore
    }
  }
  return null;
}

async function fetchDomScan(pageUrl, selector) {
  const data = await fetchHtml(pageUrl);
  const $ = cheerio.load(data);

  const node = $(selector).first();
  if (!node.length) return null;

  let imgUrl =
    pickBestFromSrcset(node.attr("srcset") || "", pageUrl) ||
    normalizeUrl(
      node.attr("src") || node.attr("data-src") || node.attr("data-lazy-src") || node.attr("data-original"),
      pageUrl
    );

  if (!imgUrl) imgUrl = normalizeUrl(node.parent("a").attr("href"), pageUrl);
  if (!imgUrl) return null;

  const meta = await probeImage(imgUrl, pageUrl);
  const score = scoreCoverCandidate(imgUrl, meta, "dom:page_scan");
  if (score < 70) return null;

  return { url: imgUrl, referer: pageUrl, source: "dom:page_scan" };
}

/* --------------------------
   Publisher specials
-------------------------- */

async function fetchPortadaByFindingLink(homeUrl) {
  const data = await fetchHtml(homeUrl);
  const $ = cheerio.load(data);

  const linkCandidates = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = ($(el).text() || "").toLowerCase();
    const h = normalizeUrl(href, homeUrl);
    if (!h) return;

    if (
      h.toLowerCase().includes("portada") ||
      h.toLowerCase().includes("capa") ||
      text.includes("portada") ||
      text.includes("capa")
    ) {
      linkCandidates.push(h);
    }
  });

  for (const u of linkCandidates.slice(0, 12)) {
    const r = await safe(fetchMetaImage(u));
    if (r) return { ...r, source: "site(portada-link)" };
  }

  return null;
}

async function fetchPublisherSpecial(publisher) {
  if (publisher.id === "lesportiu") {
    return (
      (await safe(fetchPortadaByFindingLink("https://www.lesportiudecatalunya.cat/"))) ||
      (await safe(fetchMetaImage("https://www.lesportiudecatalunya.cat/")))
    );
  }

  if (publisher.id === "superdeporte") {
    return (
      (await safe(fetchPortadaByFindingLink("https://www.superdeporte.es/"))) ||
      (await safe(fetchMetaImage("https://www.superdeporte.es/")))
    );
  }

  if (publisher.id === "estadiodeportivo") {
    return (
      (await safe(fetchPortadaByFindingLink("https://www.estadiodeportivo.com/"))) ||
      (await safe(fetchMetaImage("https://www.estadiodeportivo.com/")))
    );
  }

  return null;
}

/* --------------------------
   Nitter (optional)
-------------------------- */

function toNitterProfile(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("twitter.com") && !u.hostname.includes("x.com")) return null;
    const handle = u.pathname.split("/").filter(Boolean)[0];
    if (!handle) return null;
    return `https://nitter.net/${handle}`;
  } catch {
    return null;
  }
}

async function fetchLatestMediaFromNitter(nitterProfileUrl) {
  const rssUrl = nitterProfileUrl.replace(/\/+$/, "") + "/rss";
  const { data } = await withRetry(
    () => http.get(rssUrl, { headers: { Accept: "application/rss+xml,text/xml,*/*", "User-Agent": USER_AGENT } }),
    { tries: 2, baseDelayMs: 700 }
  );

  const $ = cheerio.load(data, { xmlMode: true });
  const item = $("item").first();
  if (!item.length) return null;

  const enc = item.find("enclosure").attr("url");
  const encUrl = normalizeUrl(enc, rssUrl);
  if (encUrl) {
    try {
      const meta = await probeImage(encUrl, nitterProfileUrl);
      const score = scoreCoverCandidate(encUrl, meta, "nitter(rss)");
      if (score >= 70) return { url: encUrl, referer: nitterProfileUrl, source: "nitter(rss)" };
    } catch {}
  }

  const desc = item.find("description").text() || "";
  const $$ = cheerio.load(desc);
  const img = $$("img").first().attr("src");
  const imgUrl = normalizeUrl(img, nitterProfileUrl);
  if (imgUrl) {
    try {
      const meta = await probeImage(imgUrl, nitterProfileUrl);
      const score = scoreCoverCandidate(imgUrl, meta, "nitter(desc)");
      if (score >= 70) return { url: imgUrl, referer: nitterProfileUrl, source: "nitter(desc)" };
    } catch {}
  }

  return null;
}

/* --------------------------
   Primary / fallback integration (your app config)
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
    const dom = await safe(fetchDomScan(primary.url, primary.selector));
    if (dom) return dom;
    return safe(fetchMetaImage(primary.url));
  }

  if (primary.method === "social:x_latest_media") {
    const nitter = (publisher.fallbacks || []).find((f) => f.type === "nitter_proxy")?.url;
    const profileUrl = nitter || toNitterProfile(primary.url);
    if (profileUrl) return fetchLatestMediaFromNitter(profileUrl);
    return null;
  }

  return null;
}

async function fetchFromFallbacks(publisher) {
  for (const fb of publisher.fallbacks || []) {
    if (fb.type === "site") {
      const r = await safe(fetchMetaImage(fb.url));
      if (r) return r;
    }
    if (fb.type === "nitter_proxy") {
      const r = await safe(fetchLatestMediaFromNitter(fb.url));
      if (r) return r;
    }
  }
  return null;
}

/* --------------------------
   today.json integration (highest-priority)
-------------------------- */

function findTodayJsonPath(outputDir) {
  // 1) Try explicit known candidates first
  for (const p of TODAY_JSON_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore invalid path
    }
  }

  // 2) Fallback: walk up from outputDir (useful if repo moved)
  let dir = outputDir;
  for (let i = 0; i <= 8; i++) {
    const p = path.join(dir, "today.json");
    if (fs.existsSync(p)) return p;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function parseTodayJson(jsonText) {
  const data = JSON.parse(jsonText);

  // Accept formats:
  // - array of items: [{...}, {...}]
  // - object with `items`: { items: [...] }
  // - object keyed by id: { "marca-2025-12-21": {...}, ... }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;

  if (data && typeof data === "object") {
    const vals = Object.values(data);
    if (vals.some((v) => v && typeof v === "object" && ("publisherId" in v || "date" in v))) {
      return vals;
    }
  }
  return [];
}

async function fetchCoverFromTodayJson(publisherId, dateStr, outputDir) {
  const todayPath = findTodayJsonPath(outputDir);
  if (!todayPath) {
    debug("[today.json] not found (looked in candidates + up from outputDir)");
    return null;
  }

  let items;
  try {
    items = parseTodayJson(fs.readFileSync(todayPath, "utf8"));
  } catch (e) {
    debug("[today.json] failed to read/parse:", todayPath, e?.message);
    return null;
  }

  const hit = items.find(
    (x) => String(x?.publisherId) === String(publisherId) && String(x?.date) === String(dateStr)
  );

  if (!hit?.sourceUrl) {
    debug("[today.json] no match:", { publisherId, dateStr, todayPath });
    return null;
  }

  debug("[today.json] match:", { publisherId, dateStr, sourceUrl: hit.sourceUrl, todayPath });

  const imgUrl = normalizeUrl(hit.sourceUrl, "https://img.kiosko.net/");
  if (!imgUrl) return null;

  try {
    const meta = await probeImage(imgUrl, null);
    const score = scoreCoverCandidate(imgUrl, meta, `today.json:${todayPath}`);
    if (score < 90) {
      debug("[today.json] rejected by score:", score, imgUrl, meta);
      return null;
    }
  } catch (e) {
    debug("[today.json] probe failed:", imgUrl, e?.message);
    return null;
  }

  debug("[today.json] using:", imgUrl);
  return {
    url: imgUrl,
    referer: null,
    source: `today.json:${path.relative(process.cwd(), todayPath)}`,
  };
}

/* --------------------------
   Candidate ranking across sources (important!)
-------------------------- */

async function rankCandidates(candidates) {
  const ranked = [];

  // Probe in sequence to avoid hammering (safe for low-skill debugging).
  // If you want faster: we can add concurrency later.
  for (const cand of candidates) {
    try {
      const meta = await probeImage(cand.url, cand.referer);
      const score = scoreCoverCandidate(cand.url, meta, cand.source);
      ranked.push({ ...cand, _score: score, _meta: meta });
    } catch (e) {
      debug("[rank] probe failed:", cand.source, cand.url, e?.message);
    }
  }

  ranked.sort((a, b) => (b._score || 0) - (a._score || 0));
  return ranked;
}

/* --------------------------
   MAIN: export fetchCover
-------------------------- */

export async function fetchCover(publisher, dateStr, outputDir, allPublishers = []) {
  if (!outputDir) throw new Error("fetchCover: outputDir is required");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  debug("[fetchCover] cwd =", process.cwd());
  debug("[fetchCover] outputDir =", outputDir);
  debug("[fetchCover] outputDir (resolved) =", path.resolve(outputDir));

  const publishersById = new Map(allPublishers.map((p) => [p.id, p]));
  publisher = resolveAlias(publisher, publishersById);

  // Gather (many) candidates; each may fail independently
  const rawCandidates = uniqueByUrl([
    await safe(fetchCoverFromTodayJson(publisher.id, dateStr, outputDir)), // highest priority
    await safe(fetchKioskoNet(publisher.id, dateStr, publisher)),
    await safe(fetchFrontpagesCom(publisher.id)),
    await safe(fetchFromPrimary(publisher)),
    await safe(fetchPublisherSpecial(publisher)),
    await safe(fetchFromFallbacks(publisher)),
  ]);

  if (!rawCandidates.length) {
    throw new Error(`Cover not found for ${publisher.id} (${dateStr})`);
  }

  // Rank candidates globally by "cover-likeness"
  const candidates = await rankCandidates(rawCandidates);

  debug(
    "[fetchCover] candidates ranked:",
    candidates.map((c) => ({ source: c.source, score: c._score, url: c.url }))
  );

  if (!candidates.length) {
    throw new Error(`All candidates invalid/unprobeable for ${publisher.id} (${dateStr})`);
  }

  let lastErr = null;

  for (const cand of candidates) {
    try {
      const urlExt = path.extname(cand.url.split("?")[0] || "");
      const tmpPath = path.join(outputDir, `${dateStr}-medium${urlExt || ".img"}`);

      const { contentType } = await downloadImage(cand.url, tmpPath, cand.referer);

      const finalExt = urlExt || extFromContentType(contentType);
      const finalFilename = `${dateStr}-medium${finalExt}`;
      const finalPath = path.join(outputDir, finalFilename);

      if (tmpPath !== finalPath) fs.renameSync(tmpPath, finalPath);

      return { url: cand.url, localFile: finalFilename, source: cand.source };
    } catch (e) {
      lastErr = e;
      debug("[fetchCover] download failed:", cand.source, cand.url, e?.message);
    }
  }

  throw new Error(
    `All candidate downloads failed for ${publisher.id} (${dateStr}): ${lastErr?.message || String(lastErr)}`
  );
}