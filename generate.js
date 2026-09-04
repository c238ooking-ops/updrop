import fs from "fs";

const ROOT_FOLDER_ID = process.env.UDROP_FOLDER_ID || null;
const KEY1 = process.env.UDROP_KEY1;
const KEY2 = process.env.UDROP_KEY2;

const API_BASE = "https://www.udrop.com/api/v2";
const VIDEO_EXTS = new Set(["mp4", "mkv", "avi", "webm", "ts"]);
const SEQUEL_TAGS = new Set(["2", "3", "4", "5", "6", "ii", "iii", "iv", "v", "part", "chapter", "returns", "reloaded"]);

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

// Extract Title, Year, and Episode cleanly
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
      title: cleanTitleString(seriesMatch[1]),
      year: null,
      season: parseInt(seriesMatch[2], 10),
      episode: parseInt(seriesMatch[3], 10)
    };
  }

  // Match 4-digit release year (1900-2099)
  let year = null;
  const yearMatch = name.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
    // Cut off everything from the year onwards so only title remains
    name = name.substring(0, name.indexOf(yearMatch[0]));
  }

  return {
    type: "movie",
    title: cleanTitleString(name),
    year: year
  };
}

function cleanTitleString(str) {
  return str
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|webrip|web-dl|bluray|remux|open matte|extended|imax|directors cut|unrated)\b/gi, "")
    .replace(/\b(x264|x265|hevc|h264|h265|avc|10bit|aac|dts|truehd|atmos|ac3|ddp5\.1|dd5\.1|dual audio|hindi|english|esub)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Strict Dual-Key Scorer
function scoreMatch(candidateTitle, candidateYear, targetTitle, targetYear) {
  const cYear = parseInt(candidateYear, 10);
  const tYear = targetYear ? parseInt(targetYear, 10) : null;

  // RULE 1: If file has a year, reject candidates with year gap > 1
  if (tYear && !isNaN(cYear)) {
    if (Math.abs(cYear - tYear) > 1) {
      return -1; // REJECT (Prevents matching 1990 with 2013)
    }
  }

  const cleanCand = normalize(candidateTitle);
  const cleanTarget = normalize(targetTitle);

  // RULE 2: Sequel Guard - If candidate has sequel terms not in target, reject
  const candWords = candidateTitle.toLowerCase().split(/\s+/);
  const targetWords = targetTitle.toLowerCase().split(/\s+/);
  for (const word of candWords) {
    if (SEQUEL_TAGS.has(word) && !targetWords.includes(word)) {
      return -1; // REJECT (Prevents "Aashiqui 2" when target is "Aashiqui")
    }
  }

  let score = 0;

  // Exact alphanumeric match
  if (cleanCand === cleanTarget) {
    score += 80;
  } else if (cleanCand.startsWith(cleanTarget)) {
    score += 40;
  } else if (cleanCand.includes(cleanTarget)) {
    score += 20;
  } else {
    return -1; // Not related
  }

  // Exact year bonus
  if (tYear && !isNaN(cYear)) {
    if (cYear === tYear) score += 50;
    else if (Math.abs(cYear - tYear) === 1) score += 20;
  }

  return score;
}

// 1. Search IMDb Suggestion API
async function searchIMDb(title, year) {
  try {
    const query = normalize(title);
    if (!query) return null;
    const firstChar = query.charAt(0);
    const url = `https://v3.sg.media-imdb.com/suggestion/${encodeURIComponent(firstChar)}/${encodeURIComponent(query)}.json`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.d?.length > 0) {
      let bestItem = null;
      let highestScore = 0;

      for (const item of data.d) {
        if (!item.id || !item.id.startsWith("tt") || item.q === "feature") continue;
        const score = scoreMatch(item.l, item.y, title, year);
        if (score > highestScore) {
          highestScore = score;
          bestItem = {
            id: item.id,
            name: item.l,
            year: item.y,
            poster: item.i?.imageUrl || ""
          };
        }
      }
      return bestItem;
    }
  } catch (e) {}
  return null;
}

// 2. Search Cinemeta
async function searchCinemeta(title, year, type) {
  try {
    const catalogType = type === "series" ? "series" : "movie";
    const query = year ? `${title} ${year}` : title;
    const url = `https://v3-cinemeta.strem.io/catalog/${catalogType}/top/search=${encodeURIComponent(query)}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.metas?.length > 0) {
      let bestItem = null;
      let highestScore = 0;

      for (const meta of data.metas) {
        const metaYear = meta.year || meta.releaseInfo;
        const score = scoreMatch(meta.name, metaYear, title, year);
        if (score > highestScore) {
          highestScore = score;
          bestItem = meta;
        }
      }
      return bestItem;
    }
  } catch (e) {}
  return null;
}

// Combined Resolver
async function resolveMetadata(parsed) {
  console.log(`🔎 Matching: "${parsed.title}" ${parsed.year ? `[Year: ${parsed.year}]` : ""}`);

  // Try IMDb First
  if (parsed.type === "movie") {
    const imdbMatch = await searchIMDb(parsed.title, parsed.year);
    if (imdbMatch) {
      console.log(`  ✅ [IMDb Locked]: ${imdbMatch.name} (${imdbMatch.year || "N/A"}) -> ${imdbMatch.id}`);
      return imdbMatch;
    }
  }

  // Fallback to Cinemeta
  const cinemetaMatch = await searchCinemeta(parsed.title, parsed.year, parsed.type);
  if (cinemetaMatch) {
    console.log(`  ✅ [Cinemeta Locked]: ${cinemetaMatch.name} (${cinemetaMatch.year || ""}) -> ${cinemetaMatch.id}`);
    return cinemetaMatch;
  }

  console.log(`  ⚠️ No valid match found respecting title + year constraint.`);
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

    // Reuse existing entry
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

    // New file resolving
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
  console.log(`\n🎉 Complete! Total active items: ${Object.keys(newDb).length}`);
}

run();
