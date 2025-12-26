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

// Avoid single-source crash: wrap in safe for test harness
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

async function probeImage(url, referer) {
  // Range GET is more reliable than HEAD on many CDNs
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
  // loosen the size guard to avoid missing real covers on some CDNs
  if ((res.data?.byteLength || 0) < 5000) {
    throw new Error(`Image probe too small (${res.data?.byteLength || 0} bytes)`);
  }
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
  // keep a sane lower bound; 5KB is often enough for a cover
  if (stat.size < 5000) throw new Error(`Downloaded too small (${stat.size})`);

  return { contentType: ct };
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

/* --------------------------
   Frontpages.com
-------------------------- */

function extractImageCandidates($, pageUrl) {
  const out = new Set();

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
      // next candidate
    }
  }

  return null;
}

/* --------------------------
   Kiosko.net helpers (direct + daily html fuzzy)
-------------------------- */

const KIOSKO_MAP = {
  marca: ["es/marca"],
  as: ["es/as"],
  mundodeportivo: ["es/mundo_deportivo", "es/mundo-deportivo"],
  sport: ["es/sport"],
  lesportiu: ["es/lesportiu", "es/l_esportiu", "es/l-esportiu"],
  estadiodeportivo: ["es/estadio_deportivo", "es/estadio-deportivo"],
  superdeporte: ["es/superdeporte", "es/super_deporte"],
  lequipe: ["fr/le_equipe", "fr/lequipe"],
  gazzetta: ["it/gazzetta_sport", "it/gazzetta-dello-sport"],
  corriere: ["it/corriere_sport", "it/corriere-dello-sport"],
  tuttosport: ["it/tuttosport"],
  abola: ["pt/abola", "pt/a_bola", "pt/a-bola"],
  record: ["pt/record"],
  ojogo: ["pt/ojogo", "pt/o_jogo", "pt/o-jogo"],
  dailystar: ["uk/daily_star"],
  mirror: ["uk/daily_mirror"],
  express: ["uk/daily_express"],
};

async function fetchKioskoNetFromDailyHtmlAny(publisher, dateStr) {
  const langByCountry = { ES: "es", FR: "fr", IT: "it", PT: "pt", UK: "uk", DE: "de" };
  const primaryLang = langByCountry[publisher.country] || "es";

  const dayUrls = [
    `https://${primaryLang}.kiosko.net/${dateStr}/`,
    `https://www.kiosko.net/${primaryLang}/${dateStr}/`,
  ];

  for (const dayUrl of dayUrls) {
    const { data } = await withRetry(() => http.get(dayUrl), {
      tries: 3,
      baseDelayMs: 700,
    });
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

      const imgUrl =
        pickBestFromSrcset(srcset, dayUrl) || normalizeUrl(src, dayUrl);

      if (!imgUrl) return;
      tiles.push({ href, alt, imgUrl, dayUrl });
    });

    if (!tiles.length) continue;

    tiles.sort((t1, t2) => {
      const s1 = scoreMatch(
        { publisherId: publisher.id, publisherName: publisher.name },
        t1.href,
        t1.alt
      );
      const s2 = scoreMatch(
        { publisherId: publisher.id, publisherName: publisher.name },
        t2.href,
        t2.alt
      );
      return s2 - s1;
    });

    const best = tiles[0];
    const bestScore = scoreMatch(
      { publisherId: publisher.id, publisherName: publisher.name },
      best.href,
      best.alt
    );

    if (bestScore < 6) continue;

    try {
      await probeImage(best.imgUrl, dayUrl);
      return { url: best.imgUrl, referer: dayUrl, source: "kiosko.net(html)" };
    } catch {
      // try next dayUrl/lang
    }
  }

  return null;
}

async function fetchKioskoNetDirectByKeys(publisherId, dateStr) {
  const keys = KIOSKO_MAP[publisherId];
  if (!keys) return null;

  const [year, month, day] = dateStr.split("-");
  const sizes = ["1500", "1000", "750", "500", "300"];

  for (const pathKey of keys) {
    const base = `https://img.kiosko.net/${year}/${month}/${day}/${pathKey}`;
    for (const size of sizes) {
      const url = `${base}.${size}.jpg`;
      try {
        await probeImage(url, null);
        return { url, referer: null, source: "kiosko.net(direct)" };
      } catch {
        // next
      }
    }
  }

  return null;
}

async function fetchKioskoNet(publisherId, dateStr, publisher) {
  try {
    const direct = await fetchKioskoNetDirectByKeys(publisherId, dateStr);
    if (direct) return direct;
  } catch {
    // ignore
  }

  // Fallback: daily HTML scan (fuzzy)
  if (publisher) {
    const fuzzy = await fetchKioskoNetFromDailyHtmlAny(publisher, dateStr);
    if (fuzzy) return fuzzy;
  }

  return null;
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

  if (!imgUrl) {
    imgUrl = normalizeUrl(node.parent("a").attr("href"), pageUrl);
  }

  if (!imgUrl) return null;
  await probeImage(imgUrl, pageUrl);
  return { url: imgUrl, referer: pageUrl, source: "dom:page_scan" };
}

/* --------------------------
   Special helpers for tricky sites
-------------------------- */

async function fetchPortadaByFindingLink(homeUrl) {
  const { data } = await withRetry(() => http.get(homeUrl), {
    tries: 3,
    baseDelayMs: 700,
  });
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

  for (const u of linkCandidates.slice(0, 8)) {
    const r = await safe(fetchMetaImage(u));
    if (r) return { ...r, source: "site(portada-link)" };
  }

  return null;
}

async function fetchPublisherSpecial(publisher) {
  // Spanish regional portadas
  if (publisher.id === "lesportiu") {
    const t =
      (await safe(fetchPortadaByFindingLink("https://www.lesportiudecatalunya.cat/"))) ||
      (await safe(fetchMetaImage("https://www.lesportiudecatalunya.cat/")));
    if (t) return t;
  }

  if (publisher.id === "superdeporte") {
    const t =
      (await safe(fetchPortadaByFindingLink("https://www.superdeporte.es/"))) ||
      (await safe(fetchMetaImage("https://www.superdeporte.es/")));
    if (t) return t;
  }

  if (publisher.id === "estadiodeportivo") {
    const t =
      (await safe(fetchPortadaByFindingLink("https://www.estadiodeportivo.com/"))) ||
      (await safe(fetchMetaImage("https://www.estadiodeportivo.com/")));
    if (t) return t;
  }

  return null;
}

/* --------------- Nitter (optional) --------------- */
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
    () => http.get(rssUrl, { headers: { Accept: "application/rss+xml,text/xml,*/*" } }),
    { tries: 2, baseDelayMs: 700 }
  );

  const $ = cheerio.load(data, { xmlMode: true });
  const item = $("item").first();
  if (!item.length) return null;

  const enc = item.find("enclosure").attr("url");
  const encUrl = normalizeUrl(enc, rssUrl);
  if (encUrl) {
    await probeImage(encUrl, nitterProfileUrl);
    return { url: encUrl, referer: nitterProfileUrl, source: "nitter(rss)" };
  }

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
    // Try DOM scan first, then meta as fallback on same page
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

export async function fetchCover(publisher, dateStr, outputDir, allPublishers = []) {
  const publishersById = new Map(allPublishers.map((p) => [p.id, p]));
  publisher = resolveAlias(publisher, publishersById);

  // Gather candidates; each may fail independently
  const candidates = uniqueByUrl([
    await safe(fetchKioskoNet(publisher.id, dateStr, publisher)),
    await safe(fetchFrontpagesCom(publisher.id)),
    await safe(fetchFromPrimary(publisher)),
    await safe(fetchPublisherSpecial(publisher)),
    await safe(fetchFromFallbacks(publisher)),
    // Optional: legacy catalog extras can go here
  ]);

  // If nothing found, fail gracefully
  if (!candidates.length) {
    throw new Error(`Cover not found for ${publisher.id}`);
  }

  // Try each candidate until one succeeds downloading
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
      // try next candidate
    }
  }

  throw new Error(`All candidate downloads failed for ${publisher.id}: ${lastErr?.message || lastErr}`);
}