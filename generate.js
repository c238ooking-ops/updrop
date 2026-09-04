import fs from "fs";

// ================= CONFIGURATION =================
const ROOT_FOLDER_ID = process.env.UDROP_FOLDER_ID || null;
const KEY1 = process.env.UDROP_KEY1;
const KEY2 = process.env.UDROP_KEY2;

const API_BASE = "https://www.udrop.com/api/v2";
const VIDEO_EXTS = new Set(["mp4", "mkv", "avi", "webm", "ts"]);
const SEQUEL_TAGS = new Set(["2", "3", "4", "5", "6", "ii", "iii", "iv", "v", "part", "chapter", "returns", "reloaded"]);

// ================= UDROP API HELPERS =================
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

// Recursively traverse active folders, filtering out any deleted/trashed items
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
        if (file.status === "deleted" || file.is_deleted === 1 || file.trashed === 1) continue;
        const ext = (file.extension || file.filename.split(".").pop() || "").toLowerCase();
        if (VIDEO_EXTS.has(ext)) allFiles.push(file);
      }
    }
    if (data.data.folders) {
      for (const sub of data.data.folders) {
        if (sub.status === "deleted" || sub.trashed === 1) continue;
        console.log(`📁 Scanning subfolder: ${sub.folderName}...`);
        const subFiles = await getAllFiles(token, accountId, sub.id);
        allFiles = allFiles.concat(subFiles);
      }
    }
  }
  return allFiles;
}

// ================= STRING & METADATA PARSING =================
function getEditionTag(filename) {
  const tags = [];
  const lower = filename.toLowerCase();

  if (lower.includes("open matte") || lower.includes("open.matte")) tags.push("Open Matte");
  if (lower.includes("imax")) tags.push("IMAX");
  if (lower.includes("extended")) tags.push("Extended");
  if (lower.includes("directors cut") || lower.includes("director's cut")) tags.push("Director's Cut");
  if (lower.includes("workprint")) tags.push("Workprint");
  if (lower.includes("35mm")) tags.push("35mm Scan");
  if (lower.includes("unrated")) tags.push("Unrated");
  if (lower.includes("remux")) tags.push("Remux");

  const resMatch = filename.match(/\b(2160p|4k|1440p|1080p|720p|480p)\b/i);
  if (resMatch && !tags.some(t => t.includes(resMatch[1].toUpperCase()))) {
    tags.push(resMatch[1].toUpperCase());
  }

  return tags.length > 0 ? tags.join(" • ") : "Standard";
}

function cleanGarbage(str) {
  return str
    .replace(/[\[\(\{].*?[\]\)\}]/g, " ")
    .replace(/[\._\-~+]/g, " ")
    .replace(/\b(workprint|scan|35mm|70mm|vhsrip|vhs|telesync|camrip|cam)\b/gi, "")
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|webrip|web-dl|bluray|brrip|bdrip|dvdrip|remux|open matte|extended|imax|directors cut|unrated)\b/gi, "")
    .replace(/\b(x264|x265|hevc|h264|h265|avc|10bit|aac|dts|truehd|atmos|ac3|ddp5\.1|dd5\.1|dual audio|hindi|english|subtitles|esub|subs)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Universal filename parser supporting vintage years, bracketed years, and leading years
function parseFilename(filename) {
  let clean = decodeURIComponent(filename).replace(/\.[^/.]+$/, "");

  // 1. Check TV Series first
  const seriesMatch = 
    clean.match(/(.*?)\s*[sS](\d+)[eE](\d+)/i) || 
    clean.match(/(.*?)\s*(\d+)x(\d+)/i) ||
    clean.match(/(.*?)\s*Season\s*(\d+)\s*Episode\s*(\d+)/i);

  if (seriesMatch) {
    return {
      type: "series",
      title: cleanGarbage(seriesMatch[1]),
      year: null,
      season: parseInt(seriesMatch[2], 10),
      episode: parseInt(seriesMatch[3], 10)
    };
  }

  let year = null;
  let titlePart = clean;

  // Case A: Bracketed year: e.g. "Spider-Man (2002)", "Aashiqui (1990)"
  const bracketYear = clean.match(/[\(\[]\s*(19\d\d|20\d\d)\s*[\)\]]/);
  if (bracketYear) {
    year = parseInt(bracketYear[1], 10);
    titlePart = clean.replace(bracketYear[0], " ");
  } 
  else {
    // Case B: Leading year: e.g. "1992 Roja"
    const leadingYear = clean.match(/^[\s\._\-]*(19\d\d|20\d\d)[\s\._\-]+([a-zA-Z].*)/);
    if (leadingYear) {
      year = parseInt(leadingYear[1], 10);
      titlePart = leadingYear[2];
    } 
    else {
      // Case C: Year anywhere or trailing: e.g. "Sikandar 1941", "Roja 1992 1080p"
      const allYears = [...clean.matchAll(/\b(19\d\d|20\d\d)\b/g)];
      if (allYears.length > 0) {
        const lastYearMatch = allYears[allYears.length - 1];
        const beforeYear = clean.substring(0, lastYearMatch.index).trim();
        const candidateTitle = cleanGarbage(beforeYear);

        if (candidateTitle.length > 0) {
          year = parseInt(lastYearMatch[0], 10);
          titlePart = candidateTitle;
        } else {
          // If title was only a year (e.g., "2012.mkv")
          titlePart = clean;
          year = null;
        }
      }
    }
  }

  return {
    type: "movie",
    title: cleanGarbage(titlePart),
    year: year
  };
}

// ================= SCORING & RESOLVER =================
function scoreCandidate(candTitle, candYearStr, targetTitle, targetYear) {
  const cYear = parseInt(candYearStr, 10);
  const tYear = targetYear ? parseInt(targetYear, 10) : null;

  // Year Guard (allow +/- 1 for release date drift)
  if (tYear && !isNaN(cYear)) {
    if (Math.abs(cYear - tYear) > 1) return -1;
  }

  const cleanCand = normalize(candTitle);
  const cleanTarget = normalize(targetTitle);

  // Sequel Guard: Disallow sequel candidate only if target DOES NOT contain that sequel marker
  const candWords = candTitle.toLowerCase().split(/\s+/);
  const targetWords = targetTitle.toLowerCase().split(/\s+/);
  for (const w of candWords) {
    if (SEQUEL_TAGS.has(w) && !targetWords.includes(w)) return -1;
  }

  let score = 0;
  if (cleanCand === cleanTarget) score += 100;
  else if (cleanCand.startsWith(cleanTarget)) score += 50;
  else if (cleanCand.includes(cleanTarget)) score += 20;
  else return -1;

  if (tYear && !isNaN(cYear)) {
    if (cYear === tYear) score += 60;
    else if (Math.abs(cYear - tYear) === 1) score += 30;
  }

  return score;
}

// Search Cinemeta with clean title, then score candidates
async function searchCinemeta(title, year, type) {
  try {
    const catalogType = type === "series" ? "series" : "movie";
    const url = `https://v3-cinemeta.strem.io/catalog/${catalogType}/top/search=${encodeURIComponent(title)}.json`;

    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.metas?.length > 0) {
      let bestItem = null;
      let highestScore = 0;

      for (const m of data.metas) {
        const mYear = m.year || m.releaseInfo;
        const score = scoreCandidate(m.name, mYear, title, year);
        if (score > highestScore) {
          highestScore = score;
          bestItem = m;
        }
      }
      return bestItem;
    }
  } catch (e) {}
  return null;
}

// Search IMDb Suggestions with clean title, then score candidates
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
        const score = scoreCandidate(item.l, item.y, title, year);
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

async function resolveMetadata(parsed) {
  if (!parsed.title || parsed.title.trim() === "") {
    console.warn(`  ⚠️ Empty title parsed. Skipping query.`);
    return null;
  }

  console.log(`🔎 Searching: "${parsed.title}" ${parsed.year ? `[Year: ${parsed.year}]` : ""}`);

  // Query Cinemeta first
  let match = await searchCinemeta(parsed.title, parsed.year, parsed.type);
  if (match) {
    console.log(`  ✅ [Cinemeta Matched]: ${match.name} (${match.year || ""}) -> ${match.id}`);
    return match;
  }

  // Query IMDb suggestions fallback
  if (parsed.type === "movie") {
    match = await searchIMDb(parsed.title, parsed.year);
    if (match) {
      console.log(`  ✅ [IMDb Matched]: ${match.name} (${match.year || ""}) -> ${match.id}`);
      return match;
    }
  }

  console.log(`  ⚠️ No strict match found. Using parsed title.`);
  return null;
}

// ================= MAIN RUNNER =================
async function run() {
  if (!KEY1 || !KEY2) {
    console.error("Missing UDROP_KEY1 or UDROP_KEY2.");
    process.exit(1);
  }

  const auth = await authorize();
  const liveFiles = await getAllFiles(auth.token, auth.accountId, ROOT_FOLDER_ID);
  console.log(`📡 Discovered ${liveFiles.length} active files on uDrop.`);

  const cachedStreams = new Map();
  if (fs.existsSync("database.json")) {
    try {
      const oldDb = JSON.parse(fs.readFileSync("database.json", "utf-8"));
      for (const [key, entry] of Object.entries(oldDb)) {
        const streams = Array.isArray(entry.streams) ? entry.streams : [entry];
        for (const s of streams) {
          if (s.url) {
            const match = s.url.match(/udrop\.com\/file\/([^/]+)/);
            const shortId = match ? match[1] : null;
            if (shortId) {
              cachedStreams.set(shortId, {
                key: key,
                meta: entry.meta,
                streamTitle: s.title
              });
            }
          }
        }
      }
      console.log(`💾 Cache contains ${cachedStreams.size} valid items.`);
    } catch (e) {
      console.log("No valid existing database found. Building fresh.");
    }
  }

  const newDb = {};
  let reusedCount = 0;
  let newAddedCount = 0;

  for (const file of liveFiles) {
    const directUrl = `https://www.udrop.com/file/${file.shortUrl}/${encodeURIComponent(file.filename)}`;
    const edition = getEditionTag(file.filename);

    // Reuse from cache if available
    if (cachedStreams.has(file.shortUrl)) {
      const cached = cachedStreams.get(file.shortUrl);
      const key = cached.key;

      if (!newDb[key]) {
        newDb[key] = { meta: cached.meta, streams: [] };
      }

      newDb[key].streams.push({
        name: "uDrop",
        title: cached.streamTitle || `${cached.meta.name} [${edition}]`,
        url: directUrl
      });
      reusedCount++;
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
    newAddedCount++;
  }

  fs.writeFileSync("database.json", JSON.stringify(newDb, null, 2));

  console.log("\n================ SYNC SUMMARY ================");
  console.log(`♻️  Reused from cache:   ${reusedCount}`);
  console.log(`➕ Newly indexed files: ${newAddedCount}`);
  console.log(`📦 Active titles in DB:  ${Object.keys(newDb).length}`);
  console.log("==============================================");
}

run();
