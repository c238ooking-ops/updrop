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
  if (lower.includes("unrated")) tags.push("Unrated");
  if (lower.includes("remux")) tags.push("Remux");

  const resMatch = filename.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
  if (resMatch) tags.push(resMatch[1].toUpperCase());

  return tags.length > 0 ? tags.join(" • ") : "Standard";
}

function cleanGarbage(str) {
  return str
    .replace(/[\[\(\{].*?[\]\)\}]/g, " ")
    .replace(/[\._\-~+]/g, " ")
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|webrip|web-dl|bluray|remux|open matte|extended|imax|directors cut|unrated)\b/gi, "")
    .replace(/\b(x264|x265|hevc|h264|h265|avc|10bit|aac|dts|truehd|atmos|ac3|ddp5\.1|dd5\.1|dual audio|hindi|english|subtitles|esub|subs)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Bidirectional and Number-Safe Filename Parser
function parseFilename(filename) {
  let clean = decodeURIComponent(filename).replace(/\.[^/.]+$/, "");

  // 1. Detect TV Series
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

  // RULE A: Explicit Year in Brackets/Parentheses -> e.g. "2012 (2009)", "Blade Runner 2049 (2017)"
  const bracketYearMatch = clean.match(/[\(\[]\s*(19\d\d|20\d\d)\s*[\)\]]/);

  if (bracketYearMatch) {
    year = parseInt(bracketYearMatch[1], 10);
    titlePart = clean.replace(bracketYearMatch[0], " ");
  } 
  else {
    // RULE B: Leading Year followed by title -> e.g. "1992 Roja"
    const leadingYearMatch = clean.match(/^[\s\._\-]*(19\d\d|20\d\d)[\s\._\-]+([a-zA-Z].*)/);

    if (leadingYearMatch) {
      year = parseInt(leadingYearMatch[1], 10);
      titlePart = leadingYearMatch[2];
    } 
    else {
      // RULE C: Trailing Year before tags -> e.g. "Roja 1992 1080p", "Aashiqui 1990 WEB-DL"
      const trailingYearMatch = clean.match(/\b(19\d\d|20\d\d)\b(?=\s*(?:4k|2160p|1080p|720p|bluray|web|remux|dvd|x264|x265|hevc|hindi|english|$))/i);

      if (trailingYearMatch) {
        const potentialYear = parseInt(trailingYearMatch[1], 10);
        const remainingTitle = clean.substring(0, trailingYearMatch.index).trim();

        // If slicing leaves string empty (e.g., "2012.mkv"), preserve whole number as title
        if (remainingTitle.length > 0) {
          year = potentialYear;
          titlePart = remainingTitle;
        } else {
          titlePart = clean;
        }
      }
    }
  }

  const finalTitle = cleanGarbage(titlePart);

  return {
    type: "movie",
    title: finalTitle || clean.trim(),
    year: year
  };
}

// ================= METADATA QUERYING =================
async function searchCinemetaCombined(title, year, type) {
  try {
    const catalogType = type === "series" ? "series" : "movie";
    const combinedQuery = year ? `${title} ${year}` : title;
    const url = `https://v3-cinemeta.strem.io/catalog/${catalogType}/top/search=${encodeURIComponent(combinedQuery)}.json`;

    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.metas?.length > 0) {
      const targetNorm = normalize(title);

      for (const m of data.metas) {
        const candNorm = normalize(m.name);
        const candYear = parseInt(m.year || m.releaseInfo, 10);

        if (/\d+$/.test(candNorm) && !/\d+$/.test(targetNorm)) continue;

        if (candNorm === targetNorm || candNorm.startsWith(targetNorm)) {
          if (year && !isNaN(candYear)) {
            if (Math.abs(candYear - year) <= 1) return m;
          } else {
            return m;
          }
        }
      }

      if (year) {
        const yearExact = data.metas.find(m => Math.abs(parseInt(m.year || m.releaseInfo, 10) - year) <= 1);
        if (yearExact) return yearExact;
      }
    }
  } catch (e) {}
  return null;
}

async function searchIMDbStrict(title, year) {
  try {
    const query = normalize(title);
    if (!query) return null;
    const firstChar = query.charAt(0);
    const url = `https://v3.sg.media-imdb.com/suggestion/${encodeURIComponent(firstChar)}/${encodeURIComponent(query)}.json`;

    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.d?.length > 0) {
      for (const item of data.d) {
        if (!item.id || !item.id.startsWith("tt") || item.q === "feature") continue;
        const itemYear = parseInt(item.y, 10);
        const itemNorm = normalize(item.l);

        if (/\d+$/.test(itemNorm) && !/\d+$/.test(query)) continue;

        if (year && !isNaN(itemYear)) {
          if (Math.abs(itemYear - year) <= 1 && (itemNorm === query || itemNorm.startsWith(query))) {
            return {
              id: item.id,
              name: item.l,
              year: item.y,
              poster: item.i?.imageUrl || ""
            };
          }
        } else if (itemNorm === query) {
          return {
            id: item.id,
            name: item.l,
            year: item.y,
            poster: item.i?.imageUrl || ""
          };
        }
      }
    }
  } catch (e) {}
  return null;
}

async function resolveMetadata(parsed) {
  if (!parsed.title || parsed.title.trim() === "") {
    console.warn(`  ⚠️ Empty title parsed. Skipping query.`);
    return null;
  }

  console.log(`🔎 Searching [Title + Year]: "${parsed.title}" ${parsed.year ? `(${parsed.year})` : ""}`);

  let match = await searchCinemetaCombined(parsed.title, parsed.year, parsed.type);
  if (match) {
    console.log(`  ✅ [Cinemeta Matched]: ${match.name} (${match.year || ""}) -> ${match.id}`);
    return match;
  }

  if (parsed.type === "movie") {
    match = await searchIMDbStrict(parsed.title, parsed.year);
    if (match) {
      console.log(`  ✅ [IMDb Matched]: ${match.name} (${match.year || ""}) -> ${match.id}`);
      return match;
    }
  }

  console.log(`  ⚠️ No verified metadata match found.`);
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

  // 1. Load existing database as read-only cache keyed by shortUrl
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

  // 2. Build updated database strictly from currently live files
  const newDb = {};
  let reusedCount = 0;
  let newAddedCount = 0;

  for (const file of liveFiles) {
    const directUrl = `https://www.udrop.com/file/${file.shortUrl}/${encodeURIComponent(file.filename)}`;
    const edition = getEditionTag(file.filename);

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
