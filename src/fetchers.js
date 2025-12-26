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

// don't let one broken source stop other sources
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

  // extra guard: if the first chunk is extremely small, it's often a placeholder
  if ((res.data?.byteLength || 0) < 3000) {
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
  if (stat.size < 10_000) throw new Error(`Downloaded too small (${stat.size})`);

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
      // next
    }
  }

  return null;
}

/* --------------------------
   Kiosko.net (direct + fuzzy daily scan)
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

function normToken(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreMatch({ publisherId, publisherName }, href, altText) {
  const h = normToken(href);
  const a = normToken(altText);
  const id = normToken(publisherId);
  const name = normToken(publisherName);

  let score = 0;
  if (h.includes(id)) score += 8;
  if (a.includes(id)) score += 8;

  for (const w of name.split(" ").filter(Boolean)) {
    if (w.length < 3) continue;
    if (h.includes(w)) score += 2;
    if (a.includes(w)) score += 2;
  }

  return score;
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

async function fetchKioskoNetFromDailyHtmlAny(publisher, dateStr) {
  const langByCountry = { ES: "es", FR: "fr", IT: "it", PT: "pt", UK: "uk", DE: "de" };
  const primaryLang = langByCountry[publisher.country] || "es";

  // Try multiple kiosko hosts/paths. This helps when some pages are missing/redirecting.
  const langsToTry = Array.from(new Set([primaryLang, "es", "pt", "it", "fr", "uk"]));

  for (const lang of langsToTry) {
    const dayUrls = [
      `https://${lang}.kiosko.net/${dateStr}/`,
      `https://www.kiosko.net/${lang}/${dateStr}/`,
    ];

    for (const dayUrl of dayUrls) {
      const res = await safe(withRetry(() => http.get(dayUrl), { tries: 2, baseDelayMs: 600 }));
      if (!res?.data) continue;

      const $ = cheerio.load(res.data);

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
        await probeImage(best.imgUrl, best.dayUrl);
        return { url: best.imgUrl, referer: best.dayUrl, source: "kiosko.net(html-fuzzy)" };
      } catch {
        // continue trying other dayUrls/langs
      }
    }
  }

  return null;
}

async function fetchKioskoNet(publisherId, dateStr, publisher) {
  const direct = await safe(fetchKioskoNetDirectByKeys(publisherId, dateStr));
  if (direct) return direct;

  if (publisher) {
    const fuzzy = await safe(fetchKioskoNetFromDailyHtmlAny(publisher, dateStr));
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
   Special helpers for tricky Spanish sites (lesportiu/superdeporte/estadiodeportivo)
   Strategy: scan homepage for a link that looks like "portada", then read og:image there.
-------------------------- */

async function fetchPortadaByFindingLink(homeUrl) {
  const { data } = await withRetry(() => http.get(homeUrl), { tries: 3, baseDelayMs: 700 });
  const $ = cheerio.load(data);

  const linkCandidates = [];
  $("a[href]").each((_, el) => {
    const hrefRaw = $(el).attr("href");
    const text = ($(el).text() || "").trim();
    const href = normalizeUrl(hrefRaw, homeUrl);
    if (!href) return;

    const h = href.toLowerCase();
    const t = text.toLowerCase();

    // match typical portada terms
    if (
      h.includes("portada") ||
      h.includes("capa") ||
      t.includes("portada") ||
      t.includes("capa")
    ) {
      linkCandidates.push(href);
    }
  });

  // Try a few distinct links
  const unique = Array.from(new Set(linkCandidates)).slice(0, 8);
  for (const u of unique) {
    const r = await safe(fetchMetaImage(u));
    if (r) return { ...r, source: "site(portada-link)" };
  }

  return null;
}

async function fetchPublisherSpecial(publisher) {
  if (publisher.id === "lesportiu") {
    // Try their homepage portada discovery + also meta directly
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
   X/Twitter fallback via Nitter (best-effort)
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
    // Try DOM scan first, then meta as fallback on same page (helps sites that changed markup)
    return (
      (await safe(fetchDomScan(primary.url, primary.selector))) ||
      (await safe(fetchMetaImage(primary.url)))
    );
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
    if (fb.type === "x_profile") {
      const nitterUrl = toNitterProfile(fb.url);
      if (nitterUrl) {
        const r = await safe(fetchLatestMediaFromNitter(nitterUrl));
        if (r) return r;
      }
    }
  }
  return null;
}

export async function fetchCover(publisher, dateStr, outputDir, allPublishers = []) {
  const publishersById = new Map(allPublishers.map((p) => [p.id, p]));
  publisher = resolveAlias(publisher, publishersById);

  // IMPORTANT: collect multiple candidates; download first that succeeds.
  const candidates = uniqueByUrl([
    await safe(fetchKioskoNet(publisher.id, dateStr, publisher)),
    await safe(fetchFrontpagesCom(publisher.id)),
    await safe(fetchFromPrimary(publisher)),
    await safe(fetchPublisherSpecial(publisher)),
    await safe(fetchFromFallbacks(publisher)),
  ]);

  if (!candidates.length) throw new Error(`Cover not found for ${publisher.id}`);

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