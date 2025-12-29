// src/fetchers.js
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

/**
 * fetchers.js
 * - Fetch cover images for publishers (sports newspapers).
 * - Sources: kiosko.net (direct CDN + NP + daily HTML), frontpages.com, publisher primary/fallbacks.
 * - Writes docs/data/today.json after success (CI compatible).
 *
 * IMPORTANT: This file defines extractKioskoDateFromUrl() ONLY ONCE.
 */

const DEBUG = process.env.COVER_SCRAPER_DEBUG === "1";
function debug(...args) {
  if (DEBUG) console.log(...args);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

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
  } catch {
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
   ONE AND ONLY ONE kiosko date parser
-------------------------- */
function extractKioskoDateFromUrl(u) {
  // https://img.kiosko.net/2025/12/27/es/marca.750.jpg
  const m = String(u || "").match(/img\.kiosko\.net\/(\d{4})\/(\d{2})\/(\d{2})\//i);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
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

    if (marker === 0xd9 || marker === 0xda) break;
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
  return null; // AVIF omitted
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

  if (String(source).startsWith("today.json")) s += 200;

  const bad = ["logo", "favicon", "sprite", "icon", "avatar", "profile", "ads", "banner", "placeholder"];
  if (bad.some((k) => lu.includes(k))) s -= 200;

  if (lu.includes("img.kiosko.net")) s += 120;
  if (lu.includes("wp-content/uploads")) s += 15;
  if (lu.includes("frontpage") || lu.includes("portada") || lu.includes("cover")) s += 10;

  if (meta?.bytes) {
    if (meta.bytes > 900000) s += 35;
    else if (meta.bytes > 400000) s += 25;
    else if (meta.bytes > 150000) s += 12;
    else if (meta.bytes < 40000) s -= 20;
  }

  if (meta?.width && meta?.height) {
    const w = meta.width;
    const h = meta.height;
    const aspect = w / h;

    if (w >= 900 && h >= 1200) s += 60;
    else if (w >= 700 && h >= 900) s += 40;
    else if (w >= 500 && h >= 700) s += 20;
    else s -= 30;

    if (aspect >= 0.5 && aspect <= 0.85) s += 40;
    else if (aspect > 1.2) s -= 60;

    if (w <= 320 || h <= 320) s -= 100;
  }

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
   Kiosko helpers
-------------------------- */

const KIOSKO_MAP = {
  // Spain
  marca: ["es/marca"],
  as: ["es/as"],
  mundodeportivo: ["es/mundodeportivo", "es/mundo_deportivo", "es/mundo-deportivo"],
  sport: ["es/sport"],
  lesportiu: ["es/el9", "es/lesportiu", "es/l_esportiu", "es/l-esportiu"],
  estadiodeportivo: ["es/estadio_deportivo", "es/estadio-deportivo"],
  superdeporte: ["es/superdeporte", "es/super_deporte"],

  // France
  lequipe: ["fr/l_equip", "fr/l_equipe", "fr/lequipe", "fr/le_equipe"],

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
  const langByCountry = { ES: "es", FR: "fr", IT: "it", PT: "pt", UK: "uk", DE: "de" };
  const lang = langByCountry[publisher?.country] || "es";

  const mapped = KIOSKO_MAP[publisherId] || [];

  const candidates = [];
  const pid = normalizeText(publisherId).replace(/\s+/g, "");
  if (pid) {
    candidates.push(pid);
    candidates.push(pid.replace(/-/g, "_"));
    candidates.push(pid.replace(/_/g, ""));
  }

  const pname = normalizeText(publisher?.name || "");
  if (pname) {
    const words = pname.split(" ").filter(Boolean);
    if (words.length) {
      candidates.push(words.join("_"));
      candidates.push(words.join(""));
      if (words.length >= 2 && words[0].length === 1) {
        candidates.push(`${words[0]}_${words[1]}`);
        if (words[1].length >= 4) candidates.push(`${words[0]}_${words[1].slice(0, words[1].length - 1)}`); // l_equip
      }
    }
  }

  const generated = uniqueStrings(candidates).map((slug) => `${lang}/${slug}`);
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

  for (const pathKey of pathKeys) {
    const base = `https://img.kiosko.net/${year}/${month}/${day}/${pathKey}`;
    for (const size of sizes) {
      const url = `${base}.${size}.jpg`;
      try {
        const meta = await probeImage(url, null);
        const score = scoreCoverCandidate(url, meta, "kiosko.net(direct)");
        if (score >= 70) return { url, referer: null, source: "kiosko.net(direct)" };
      } catch {
        // next
      }
    }
  }
  return null;
}

async function fetchKioskoNetNP(publisherId, publisher, dateStr) {
  // Generate NP slugs from map + variants
  const keys = buildKioskoPathKeys(publisherId, publisher);
  if (!keys.length) return null;

  const langByCountry = { ES: "es", FR: "fr", IT: "it", PT: "pt", UK: "uk", DE: "de" };
  const primaryLang = langByCountry[publisher?.country] || "es";

  // NP uses just the slug part
  const slugs = uniqueStrings(keys.map((k) => k.split("/")[1]).filter(Boolean));

  const npUrls = [];
  for (const slug of slugs) {
    npUrls.push(`https://${primaryLang}.kiosko.net/${primaryLang}/np/${slug}.html`);
    npUrls.push(`https://www.kiosko.net/${primaryLang}/np/${slug}.html`);
  }

  for (const pageUrl of npUrls) {
    const data = await fetchHtml(pageUrl);
    const $ = cheerio.load(data);

    const portada = normalizeUrl($("#portada").attr("src"), pageUrl);
    if (portada) {
      // strict date for kiosko CDN
      if (portada.includes("img.kiosko.net")) {
        const kioskoDate = extractKioskoDateFromUrl(portada);
        if (kioskoDate && kioskoDate !== dateStr) {
          // reject yesterday
        } else {
          try {
            const meta = await probeImage(portada, pageUrl);
            const score = scoreCoverCandidate(portada, meta, "kiosko.net(np:#portada)");
            if (score >= 70) return { url: portada, referer: pageUrl, source: "kiosko.net(np:#portada)" };
          } catch {}
        }
      } else {
        try {
          const meta = await probeImage(portada, pageUrl);
          const score = scoreCoverCandidate(portada, meta, "kiosko.net(np:#portada)");
          if (score >= 70) return { url: portada, referer: pageUrl, source: "kiosko.net(np:#portada)" };
        } catch {}
      }
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

      // strict date for kiosko CDN
      if (t.imgUrl.includes("img.kiosko.net")) {
        const kioskoDate = extractKioskoDateFromUrl(t.imgUrl);
        if (kioskoDate && kioskoDate !== dateStr) continue;
      }

      try {
        const meta = await probeImage(t.imgUrl, dayUrl);
        const score = scoreCoverCandidate(t.imgUrl, meta, "kiosko.net(daily-html)");
        if (score >= 70) return { url: t.imgUrl, referer: dayUrl, source: "kiosko.net(daily-html)" };
      } catch {}
    }
  }

  return null;
}

async function fetchKioskoNet(publisherId, dateStr, publisher) {
  const direct = await safe(fetchKioskoNetDirectByKeys(publisherId, dateStr, publisher));
  if (direct) return direct;

  const np = publisher ? await safe(fetchKioskoNetNP(publisherId, publisher, dateStr)) : null;
  if (np) return np;

  const daily = publisher ? await safe(fetchKioskoNetFromDailyHtmlAny(publisher, dateStr)) : null;
  if (daily) return daily;

  return null;
}

/* --------------------------
   today.json integration
-------------------------- */

function getTodayJsonPath() {
  // CI-friendly: write into docs/data/today.json inside repo
  return process.env.TODAY_JSON_PATH || path.resolve(process.cwd(), "docs/data/today.json");
}

function upsertTodayJsonEntry({ publisher, dateStr, localFile, sourceUrl }) {
  const todayPath = getTodayJsonPath();

  const countryLower = String(publisher.country || "").toLowerCase();
  const publisherId = publisher.id;

  const imageMediumUrl = `./data/images/${countryLower}/${publisherId}/${localFile}`;

  const entry = {
    id: `${publisherId}-${dateStr}`,
    publisherId,
    publisherName: publisher.name,
    country: publisher.country,
    groupLabel: publisher.groupLabel || "",
    date: dateStr,
    imageMediumUrl,
    sourceUrl,
    scrapedAt: new Date().toISOString(),
  };

  let arr = [];
  if (fs.existsSync(todayPath)) {
    try {
      const raw = fs.readFileSync(todayPath, "utf8");
      const parsed = JSON.parse(raw);
      arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    } catch {
      arr = [];
    }
  }

  // remove old entry for same publisher+date
  arr = arr.filter((x) => !(x?.publisherId === publisherId && x?.date === dateStr));
  arr.push(entry);

  arr.sort((a, b) => String(a.publisherId).localeCompare(String(b.publisherId)));

  fs.mkdirSync(path.dirname(todayPath), { recursive: true });
  fs.writeFileSync(todayPath, JSON.stringify(arr, null, 2), "utf8");

  return todayPath;
}

function findTodayJsonPath(outputDir) {
  const candidates = [
    process.env.TODAY_JSON_PATH,
    path.resolve(process.cwd(), "docs/data/today.json"),
    path.resolve(outputDir || ".", "today.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }

  // walk up from outputDir
  let dir = outputDir || process.cwd();
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
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (data && typeof data === "object") return Object.values(data);
  return [];
}

async function fetchCoverFromTodayJson(publisherId, dateStr, outputDir) {
  const todayPath = findTodayJsonPath(outputDir) || getTodayJsonPath();
  if (!todayPath || !fs.existsSync(todayPath)) return null;

  let items;
  try {
    items = parseTodayJson(fs.readFileSync(todayPath, "utf8"));
  } catch {
    return null;
  }

  const hit = items.find(
    (x) => String(x?.publisherId) === String(publisherId) && String(x?.date) === String(dateStr)
  );
  if (!hit?.sourceUrl) return null;

  const imgUrl = normalizeUrl(hit.sourceUrl, "https://img.kiosko.net/");
  if (!imgUrl) return null;

  // strict kiosko date
  if (imgUrl.includes("img.kiosko.net")) {
    const kioskoDate = extractKioskoDateFromUrl(imgUrl);
    if (kioskoDate && kioskoDate !== dateStr) return null;
  }

  try {
    const meta = await probeImage(imgUrl, null);
    const score = scoreCoverCandidate(imgUrl, meta, `today.json:${todayPath}`);
    if (score < 90) return null;
  } catch {
    return null;
  }

  return { url: imgUrl, referer: null, source: `today.json:${path.relative(process.cwd(), todayPath)}` };
}

/* --------------------------
   frontpages candidates extractor
-------------------------- */

function extractImageCandidates($, pageUrl, rawHtml = "") {
  const out = new Set();

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

  const matches =
    String(rawHtml).match(/https?:\/\/[^"' )]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"') ]*)?/gi) || [];
  for (const m of matches) out.add(m);

  return [...out]
    .map((u) => normalizeUrl(u, pageUrl))
    .filter(Boolean)
    .filter((u) => {
      const lu = u.toLowerCase();
      if (lu.includes("favicon") || lu.includes("sprite")) return false;
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
    } catch {}
  }

  if (best && best.score >= 55) return { url: best.url, referer: pageUrl, source: "frontpages.com" };
  return null;
}

/* --------------------------
   Publisher primary/fallback integration
-------------------------- */

function resolveAlias(publisher, publishersById) {
  if (publisher?.type === "alias" && publisher.aliasOf) {
    return publishersById.get(publisher.aliasOf) || publisher;
  }
  return publisher;
}

async function fetchFromPrimary(publisher) {
  const { primary } = publisher || {};
  if (!primary?.url || !primary?.method) return null;

  if (primary.method === "og:image") return fetchMetaImage(primary.url, [primary.selector].filter(Boolean));
  if (primary.method === "dom:page_scan") {
    const dom = await safe(fetchDomScan(primary.url, primary.selector));
    if (dom) return dom;
    return safe(fetchMetaImage(primary.url));
  }
  return null;
}

async function fetchFromFallbacks(publisher) {
  for (const fb of publisher?.fallbacks || []) {
    if (fb.type === "site") {
      const r = await safe(fetchMetaImage(fb.url));
      if (r) return r;
    }
  }
  return null;
}

async function fetchPublisherSpecial(publisher) {
  // keep minimal; add your special cases here if needed
  return null;
}

/* --------------------------
   Candidate ranking
-------------------------- */

async function rankCandidates(candidates) {
  const ranked = [];
  for (const cand of candidates) {
    try {
      const meta = await probeImage(cand.url, cand.referer);
      const score = scoreCoverCandidate(cand.url, meta, cand.source);
      ranked.push({ ...cand, _score: score });
    } catch (e) {
      debug("[rank] probe failed:", cand.source, cand.url, e?.message);
    }
  }
  ranked.sort((a, b) => (b._score || 0) - (a._score || 0));
  return ranked;
}

/* --------------------------
   EXPORT: fetchCover
-------------------------- */

export async function fetchCover(publisher, dateStr, outputDir, allPublishers = []) {
  if (!publisher?.id) throw new Error("fetchCover: publisher.id missing");
  if (!dateStr) throw new Error("fetchCover: dateStr missing");
  if (!outputDir) throw new Error("fetchCover: outputDir is required");

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const publishersById = new Map(allPublishers.map((p) => [p.id, p]));
  publisher = resolveAlias(publisher, publishersById);

  const rawCandidates = uniqueByUrl([
    await safe(fetchCoverFromTodayJson(publisher.id, dateStr, outputDir)),
    await safe(fetchKioskoNet(publisher.id, dateStr, publisher)),
    await safe(fetchFrontpagesCom(publisher.id)),
    await safe(fetchFromPrimary(publisher)),
    await safe(fetchPublisherSpecial(publisher)),
    await safe(fetchFromFallbacks(publisher)),
  ]);

  if (!rawCandidates.length) throw new Error(`Cover not found for ${publisher.id} (${dateStr})`);

  const candidates = await rankCandidates(rawCandidates);
  if (!candidates.length) throw new Error(`All candidates invalid for ${publisher.id} (${dateStr})`);

  let lastErr = null;

  for (const cand of candidates) {
    try {
      // Strict kiosko date check at final stage too (extra safety)
      if (cand.url.includes("img.kiosko.net")) {
        const kioskoDate = extractKioskoDateFromUrl(cand.url);
        if (kioskoDate && kioskoDate !== dateStr) continue;
      }

      const urlExt = path.extname(cand.url.split("?")[0] || "");
      const tmpPath = path.join(outputDir, `${dateStr}-medium${urlExt || ".img"}`);

      const { contentType } = await downloadImage(cand.url, tmpPath, cand.referer);

      const finalExt = urlExt || extFromContentType(contentType);
      const finalFilename = `${dateStr}-medium${finalExt}`;
      const finalPath = path.join(outputDir, finalFilename);

      if (tmpPath !== finalPath) fs.renameSync(tmpPath, finalPath);

      // Update today.json in CI
      upsertTodayJsonEntry({
        publisher,
        dateStr,
        localFile: finalFilename,
        sourceUrl: cand.url,
      });

      // CI logging
      try {
        const tpath = getTodayJsonPath();
        console.log("[today.json] updated:", tpath);
      } catch {}

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
