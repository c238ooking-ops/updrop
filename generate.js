import fs from "fs";

const ROOT_FOLDER_ID = process.env.UDROP_FOLDER_ID || null;
const KEY1 = process.env.UDROP_KEY1;
const KEY2 = process.env.UDROP_KEY2;

const API_BASE = "https://www.udrop.com/api/v2";
const VIDEO_EXTS = new Set(["mp4", "mkv", "avi", "webm", "ts"]);

async function authorize() {
  const res = await fetch(`${API_BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key1: KEY1, key2: KEY2 })
  });
  const data = await res.json();
  if (data._status !== "success") throw new Error(`Auth failed: ${data.response}`);
  return { token: data.data.access_token, accountId: data.data.account_id };
}

async function getAllFiles(token, accountId, folderId = null) {
  let allFiles = [];
  const body = { access_token: token, account_id: accountId };
  if (folderId) body.parent_folder_id = folderId;

  const res = await fetch(`${API_BASE}/folder/listing`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const data = await res.json();

  if (data._status === "success" && data.data) {
    if (data.data.files) {
      for (const file of data.data.files) {
        const ext = (file.extension || file.filename.split(".").pop() || "").toLowerCase();
        if (VIDEO_EXTS.has(ext)) allFiles.push(file);
      }
    }
    if (data.data.folders) {
      for (const sub of data.data.folders) {
        const subFiles = await getAllFiles(token, accountId, sub.id);
        allFiles = allFiles.concat(subFiles);
      }
    }
  }
  return allFiles;
}

function getEditionTag(filename) {
  const tags = [];
  const lower = filename.toLowerCase();

  if (lower.includes("open matte") || lower.includes("open.matte")) tags.push("Open Matte");
  if (lower.includes("imax")) tags.push("IMAX");
  if (lower.includes("extended")) tags.push("Extended");
  if (lower.includes("directors cut") || lower.includes("director's cut")) tags.push("Director's Cut");
  if (lower.includes("unrated")) tags.push("Unrated");
  if (lower.includes("remux")) tags.push("Remux");

  const resMatch = filename.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
  if (resMatch) tags.push(resMatch[1].toUpperCase());

  return tags.length > 0 ? tags.join(" • ") : "Standard";
}

// 1. Strict Filename Parser: Title and Year extracted first
function parseFilename(filename) {
  let name = decodeURIComponent(filename)
    .replace(/\.[^/.]+$/, "")
    .replace(/[\[\(\{].*?[\]\)\}]/g, " ")
    .replace(/[\._\-~+]/g, " ");

  // Check for TV series pattern first (S01E01 / 1x01)
  const seriesMatch = 
    name.match(/(.*?)\s*[sS](\d+)[eE](\d+)/i) || 
    name.match(/(.*?)\s*(\d+)x(\d+)/i) ||
    name.match(/(.*?)\s*Season\s*(\d+)\s*Episode\s*(\d+)/i);

  if (seriesMatch) {
    return {
      type: "series",
      title: cleanString(seriesMatch[1]),
      year: null,
      season: parseInt(seriesMatch[2], 10),
      episode: parseInt(seriesMatch[3], 10)
    };
  }

  // Detect 4-digit release year (1900-2099)
  let year = null;
  const yearMatch = name.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
    // Everything before the year is the actual title
    name = name.substring(0, name.indexOf(yearMatch[0]));
  }

  return {
    type: "movie",
    title: cleanString(name),
    year: year
  };
}

function cleanString(str) {
  return str
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|webrip|web-dl|bluray|remux|open matte|extended|imax|directors cut|unrated)\b/gi, "")
    .replace(/\b(x264|x265|hevc|h264|h265|avc|10bit|aac|dts|truehd|atmos|ac3|ddp5\.1|dd5\.1|dual audio|hindi|english|esub)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// 2. High-Precision IMDb Suggestions Search
async function searchIMDb(title, year) {
  try {
    const query = normalizeTitle(title);
    if (!query) return null;
    const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.d?.length > 0) {
      const candidates = data.d.filter(item => item.id && item.id.startsWith("tt") && item.q !== "feature");

      // Pass 1: Strict match on Title + Year (±1 year for festival releases)
      if (year) {
        const strictMatch = candidates.find(item => {
          const itemYear = parseInt(item.y, 10);
          const yearDiff = Math.abs(itemYear - year);
          const sameTitle = normalizeTitle(item.l) === query || item.l.toLowerCase().includes(title.toLowerCase());
          return sameTitle && yearDiff <= 1;
        });
        if (strictMatch) {
          return {
            id: strictMatch.id,
            name: strictMatch.l,
            year: strictMatch.y,
            poster: strictMatch.i?.imageUrl || ""
          };
        }
      }

      // Pass 2: Strict match on Title alone
      const titleMatch = candidates.find(item => normalizeTitle(item.l) === query);
      if (titleMatch) {
        return {
          id: titleMatch.id,
          name: titleMatch.l,
          year: titleMatch.y,
          poster: titleMatch.i?.imageUrl || ""
        };
      }

      // Pass 3: Top candidate if it contains the full title
      const fallback = candidates[0];
      if (fallback && fallback.l.toLowerCase().includes(title.toLowerCase())) {
        return {
          id: fallback.id,
          name: fallback.l,
          year: fallback.y,
          poster: fallback.i?.imageUrl || ""
        };
      }
    }
  } catch (e) {}
  return null;
}

// 3. Cinemeta Fallback Search
async function searchCinemeta(title, year, type) {
  try {
    const catalogType = type === "series" ? "series" : "movie";
    const query = year ? `${title} ${year}` : title;
    const url = `https://v3-cinemeta.strem.io/catalog/${catalogType}/top/search=${encodeURIComponent(query)}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.metas?.length > 0) {
      const normTitle = normalizeTitle(title);

      if (year) {
        const exact = data.metas.find(m => {
          const mYear = parseInt(m.year || m.releaseInfo, 10);
          const sameTitle = normalizeTitle(m.name) === normTitle || m.name.toLowerCase().includes(title.toLowerCase());
          return sameTitle && Math.abs(mYear - year) <= 1;
        });
        if (exact) return exact;
      }

      const match = data.metas.find(m => normalizeTitle(m.name) === normTitle);
      if (match) return match;

      return data.metas[0];
    }
  } catch (e) {}
  return null;
}

// Master Metadata Resolver: Prioritizes IMDb Title + Year
async function resolveMetadata(parsed) {
  console.log(`🔎 Resolving: "${parsed.title}" ${parsed.year ? `[Year: ${parsed.year}]` : ""}`);

  // 1. For movies, query IMDb directly first (most accurate title + year correlation)
  if (parsed.type === "movie") {
    const imdbMatch = await searchIMDb(parsed.title, parsed.year);
    if (imdbMatch) {
      console.log(`  ✅ [IMDb Hit]: ${imdbMatch.name} (${imdbMatch.year || "N/A"}) -> ${imdbMatch.id}`);
      return imdbMatch;
    }
  }

  // 2. Query Cinemeta (used for TV shows and as fallback for movies)
  const cinemetaMatch = await searchCinemeta(parsed.title, parsed.year, parsed.type);
  if (cinemetaMatch) {
    console.log(`  ✅ [Cinemeta Hit]: ${cinemetaMatch.name} (${cinemetaMatch.year || ""}) -> ${cinemetaMatch.id}`);
    return cinemetaMatch;
  }

  console.log(`  ⚠️ No exact IMDb/Cinemeta match found. Using parsed title.`);
  return null;
}

async function run() {
  if (!KEY1 || !KEY2) {
    console.error("Missing UDROP_KEY1 or UDROP_KEY2.");
    process.exit(1);
  }

  const auth = await authorize();
  const liveFiles = await getAllFiles(auth.token, auth.accountId, ROOT_FOLDER_ID);
  console.log(`📡 Discovered ${liveFiles.length} files on uDrop.`);

  let oldDb = {};
  if (fs.existsSync("database.json")) {
    try {
      oldDb = JSON.parse(fs.readFileSync("database.json", "utf-8"));
    } catch (e) {}
  }

  const cachedStreamsByUrl = new Map();
  for (const [key, entry] of Object.entries(oldDb)) {
    const streams = Array.isArray(entry.streams) ? entry.streams : [entry];
    for (const s of streams) {
      if (s.url) cachedStreamsByUrl.set(s.url, { key, meta: entry.meta });
    }
  }

  const newDb = {};

  for (const file of liveFiles) {
    const directUrl = `https://www.udrop.com/file/${file.shortUrl}/${encodeURIComponent(file.filename)}`;
    const edition = getEditionTag(file.filename);

    // Reuse existing entry if present
    if (cachedStreamsByUrl.has(directUrl)) {
      const cached = cachedStreamsByUrl.get(directUrl);
      const key = cached.key;

      if (!newDb[key]) {
        newDb[key] = { meta: cached.meta, streams: [] };
      }
      newDb[key].streams.push({
        name: "uDrop",
        title: `${cached.meta.name} [${edition}]`,
        url: directUrl
      });
      continue;
    }

    // New file: Run strict Title + Year resolver
    const parsed = parseFilename(file.filename);
    const meta = await resolveMetadata(parsed);

    let streamKey = meta?.id || `custom_${Math.random().toString(36).substring(2, 8)}`;
    if (parsed.type === "series" && meta?.id) {
      streamKey = `${meta.id}:${parsed.season}:${parsed.episode}`;
    }

    if (!newDb[streamKey]) {
      newDb[streamKey] = {
        meta: {
          name: meta?.name || parsed.title,
          poster: meta?.poster || "",
          type: parsed.type
        },
        streams: []
      };
    }

    const displayTitle = parsed.type === "series"
      ? `S${parsed.season} E${parsed.episode} [${edition}]`
      : `${meta?.name || parsed.title} [${edition}]`;

    newDb[streamKey].streams.push({
      name: "uDrop",
      title: displayTitle,
      url: directUrl
    });
  }

  fs.writeFileSync("database.json", JSON.stringify(newDb, null, 2));
  console.log(`\n🎉 Sync complete! Total active items: ${Object.keys(newDb).length}`);
}

run();
