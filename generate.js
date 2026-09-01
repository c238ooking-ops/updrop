import fs from "fs";

function normalizeLink(url) {
  let cleanUrl = url.trim();
  if (cleanUrl.includes("udrop.com/") && !cleanUrl.includes("udrop.com/file/")) {
    return cleanUrl.replace(/udrop\.com\//i, "udrop.com/file/");
  }
  return cleanUrl;
}

function parseFilename(filename) {
  let name = decodeURIComponent(filename)
    .replace(/\.[^/.]+$/, "")
    .replace(/[\[\(\{].*?[\]\)\}]/g, " ")
    .replace(/[\._\-~+]/g, " ");

  const seriesMatch = 
    name.match(/(.*?)\s*[sS](\d+)[eE](\d+)/i) || 
    name.match(/(.*?)\s*(\d+)x(\d+)/i) ||
    name.match(/(.*?)\s*Season\s*(\d+)\s*Episode\s*(\d+)/i);

  if (seriesMatch) {
    return {
      type: "series",
      title: seriesMatch[1].trim(),
      year: null,
      season: parseInt(seriesMatch[2], 10),
      episode: parseInt(seriesMatch[3], 10)
    };
  }

  let year = null;
  const yearMatch = name.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    year = yearMatch[1];
    name = name.substring(0, name.indexOf(yearMatch[0]));
  }

  const cleanTitle = name
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|576p|hdrip|webrip|web-dl|web|bluray|brrip|bdrip|dvdrip|remux|scan|open matte|extended|unrated|directors cut)\b/gi, "")
    .replace(/\b(x264|x265|hevc|h264|h265|avc|10bit|aac|dts|dts-hd|truehd|atmos|ac3|ddp5\.1|dd5\.1|dual audio|hindi|english|esub)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return { type: "movie", title: cleanTitle, year };
}

async function searchCinemeta(title, year, type) {
  try {
    const catalogType = type === "series" ? "series" : "movie";
    const query = year ? `${title} ${year}` : title;
    const url = `https://v3-cinemeta.strem.io/catalog/${catalogType}/top/search=${encodeURIComponent(query)}.json`;
    const res = await fetch(url);
    const data = await res.json();
    if (data?.metas?.length > 0) {
      if (year) {
        const exact = data.metas.find(m => m.year === year || m.releaseInfo === year);
        if (exact) return exact;
      }
      return data.metas[0];
    }
  } catch (e) {}
  return null;
}

async function searchIMDb(title, year) {
  try {
    const query = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    if (data?.d?.length > 0) {
      const candidates = data.d.filter(item => item.id && item.id.startsWith("tt"));
      if (year) {
        const exact = candidates.find(item => item.y == year);
        if (exact) return { id: exact.id, name: exact.l, year: exact.y, poster: exact.i?.imageUrl || "" };
      }
      const top = candidates[0];
      if (top) return { id: top.id, name: top.l, year: top.y, poster: top.i?.imageUrl || "" };
    }
  } catch (e) {}
  return null;
}

async function run() {
  if (!fs.existsSync("links.txt")) {
    console.error("links.txt not found!");
    process.exit(1);
  }

  // 1. Load existing database cache to preserve old entries
  let db = {};
  if (fs.existsSync("database.json")) {
    try {
      db = JSON.parse(fs.readFileSync("database.json", "utf-8"));
      console.log(`Loaded ${Object.keys(db).length} cached entries from database.json.`);
    } catch (err) {
      console.warn("Could not parse existing database.json, rebuilding from scratch.");
    }
  }

  // Build a reverse lookup set of existing URLs to avoid re-scraping
  const indexedUrls = new Set(Object.values(db).map(entry => entry.url));

  const rawLines = fs.readFileSync("links.txt", "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("http"));

  let newItemsCount = 0;

  for (const rawUrl of rawLines) {
    const directUrl = normalizeLink(rawUrl);

    // Skip if URL is already cached
    if (indexedUrls.has(directUrl)) {
      continue;
    }

    const rawFilename = decodeURIComponent(directUrl.split("/").pop());
    const parsed = parseFilename(rawFilename);

    console.log(`[New Item] Searching: "${parsed.title}" ${parsed.year ? `(${parsed.year})` : ""}`);

    let meta = await searchCinemeta(parsed.title, parsed.year, parsed.type);
    if (!meta && parsed.type === "movie") {
      meta = await searchIMDb(parsed.title, parsed.year);
    }

    let streamKey = meta?.id || `custom_${Math.random().toString(36).substring(2, 8)}`;
    if (parsed.type === "series" && meta?.id) {
      streamKey = `${meta.id}:${parsed.season}:${parsed.episode}`;
    }

    const titleDisplay = parsed.type === "series" ? `S${parsed.season} E${parsed.episode}` : rawFilename;
    const finalName = meta?.name || parsed.title;
    const finalPoster = meta?.poster || "";

    db[streamKey] = {
      name: "uDrop",
      title: titleDisplay,
      url: directUrl,
      meta: {
        name: finalName,
        poster: finalPoster,
        type: parsed.type
      }
    };

    indexedUrls.add(directUrl);
    newItemsCount++;
  }

  fs.writeFileSync("database.json", JSON.stringify(db, null, 2));
  console.log(`Done! Added ${newItemsCount} new items. Total items in database: ${Object.keys(db).length}`);
}

run();
