import fs from "fs";

const ROOT_FOLDER_ID = process.env.UDROP_FOLDER_ID || null;
const KEY1 = process.env.UDROP_KEY1;
const KEY2 = process.env.UDROP_KEY2;

const API_BASE = "https://www.udrop.com/api/v2";
const VIDEO_EXTS = new Set(["mp4", "mkv", "avi", "webm", "ts"]);
const SEQUEL_TERMS = new Set(["2", "3", "4", "5", "6", "ii", "iii", "iv", "v", "part", "chapter", "returns", "reloaded"]);

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

// 1. Recursive crawler with strict TRASH/DELETED filter
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
        // Exclude trashed, deleted, or pending files
        const isLive = file.status === "active" || file.status === 1 || file.deleted === false || file.deleted === 0 || !file.status;
        const notInTrash = !file.in_trash && !file.is_trash && file.folder_id !== "trash";

        if (isLive && notInTrash) {
          const ext = (file.extension || file.filename.split(".").pop() || "").toLowerCase();
          if (VIDEO_EXTS.has(ext)) {
            allFiles.push(file);
          }
        }
      }
    }
    if (data.data.folders) {
      for (const sub of data.data.folders) {
        if (!sub.in_trash && sub.folderName?.toLowerCase() !== "trash") {
          const subFiles = await getAllFiles(token, accountId, sub.id);
          allFiles = allFiles.concat(subFiles);
        }
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

// 2. Strict Left-to-Right Title & Year Extraction
function parseFilename(filename) {
  let raw = decodeURIComponent(filename).replace(/\.[^/.]+$/, "");

  // Series check (S01E01, 1x01)
  const seriesMatch = 
    raw.match(/(.*?)\s*[sS](\d+)[eE](\d+)/i) || 
    raw.match(/(.*?)\s*(\d+)x(\d+)/i) ||
    raw.match(/(.*?)\s*Season\s*(\d+)\s*Episode\s*(\d+)/i);

  if (seriesMatch) {
    return {
      type: "series",
      title: cleanTitle(seriesMatch[1]),
      year: null,
      season: parseInt(seriesMatch[2], 10),
      episode: parseInt(seriesMatch[3], 10)
    };
  }

  // Find 4-digit release year (1900-2099)
  let year = null;
  const yearMatch = raw.match(/[\(\[\s\._\-]?(19\d\d|20\d\d)[\)\]\s\._\-]?/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
    // Everything BEFORE the year is strictly the title
    raw = raw.substring(0, yearMatch.index);
  }

  return {
    type: "movie",
    title: cleanTitle(raw),
    year: year
  };
}

function cleanTitle(str) {
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

// 3. Dual Search: Title AND Year queried together from character 0
async function searchUnified(title, year, type) {
  const catalogType = type === "series" ? "series" : "movie";
  
  // Search query binds Title + Year together
  const fullSearchQuery = year ? `${title} ${year}` : title;
  console.log(`🔎 Querying Cinemeta/IMDb together: "${fullSearchQuery}"`);

  try {
    const url = `https://v3-cinemeta.strem.io/catalog/${catalogType}/top/search=${encodeURIComponent(fullSearchQuery)}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    if (data?.metas?.length > 0) {
      const cleanTargetTitle = normalize(title);
      const targetWords = title.toLowerCase().split(/\s+/);

      for (const meta of data.metas) {
        const metaTitle = meta.name;
        const cleanMetaTitle = normalize(metaTitle);
        const metaYear = parseInt(meta.year || meta.releaseInfo, 10);

        // RULE A: Year constraint (hard reject if outside 1-year drift)
        if (year && !isNaN(metaYear)) {
          if (Math.abs(metaYear - year) > 1) continue;
        }

        // RULE B: Sequel Blocker (rejects Aashiqui 2 if filename is Aashiqui)
        const metaWords = metaTitle.toLowerCase().split(/\s+/);
        let sequelLeak = false;
        for (const w of metaWords) {
          if (SEQUEL_TERMS.has(w) && !targetWords.includes(w)) {
            sequelLeak = true;
            break;
          }
        }
        if (sequelLeak) continue;

        // RULE C: Must match from beginning of title
        if (cleanMetaTitle.startsWith(cleanTargetTitle) || cleanTargetTitle.startsWith(cleanMetaTitle)) {
          return meta;
        }
      }

      // Fallback: If year matches exactly, accept candidate 0 if not a sequel leak
      if (year) {
        const candidate = data.metas[0];
        const candYear = parseInt(candidate.year || candidate.releaseInfo, 10);
        if (candYear === year) return candidate;
      }
    }
  } catch (e) {
    console.error("Search error:", e.message);
  }

  return null;
}

async function run() {
  if (!KEY1 || !KEY2) {
    console.error("Missing UDROP_KEY1 or UDROP_KEY2.");
    process.exit(1);
  }

  const auth = await authorize();
  const liveFiles = await getAllFiles(auth.token, auth.accountId, ROOT_FOLDER_ID);
  console.log(`📡 Discovered ${liveFiles.length} strictly active files on uDrop.`);

  // Load existing cache by uDrop shortUrl
  const cachedStreams = new Map();
  if (fs.existsSync("database.json")) {
    try {
      const oldDb = JSON.parse(fs.readFileSync("database.json", "utf-8"));
      for (const [key, entry] of Object.entries(oldDb)) {
        const streams = Array.isArray(entry.streams) ? entry.streams : [entry];
        for (const s of streams) {
          if (s.url) {
            const match = s.url.match(/udrop\.com\/file\/([^/]+)/);
            const fileKey = match ? match[1] : s.url;
            cachedStreams.set(fileKey, { key, meta: entry.meta, streamTitle: s.title });
          }
        }
      }
    } catch (e) {}
  }

  // The new database is constructed ONLY from files verified alive in this run
  const newDb = {};
  let reusedCount = 0;
  let newAddedCount = 0;

  for (const file of liveFiles) {
    const directUrl = `https://www.udrop.com/file/${file.shortUrl}/${encodeURIComponent(file.filename)}`;
    const edition = getEditionTag(file.filename);

    // Reuse existing matched metadata
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

    // Process new files
    const parsed = parseFilename(file.filename);
    const meta = await searchUnified(parsed.title, parsed.year, parsed.type);

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

    console.log(`  ✅ [Matched]: "${parsed.title}" ${parsed.year || ""} -> ${meta ? meta.name : "Custom"} (${streamKey})`);
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
