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

// Recursively traverse every folder and subfolder
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
        if (VIDEO_EXTS.has(ext)) {
          allFiles.push(file);
        }
      }
    }
    if (data.data.folders) {
      for (const sub of data.data.folders) {
        console.log(`📁 Scanning subfolder: ${sub.folderName}...`);
        const subFiles = await getAllFiles(token, accountId, sub.id);
        allFiles = allFiles.concat(subFiles);
      }
    }
  }
  return allFiles;
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
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|webrip|web-dl|bluray|remux)\b/gi, "")
    .replace(/\b(x264|x265|hevc|aac|dts|dual audio|hindi|english|esub)\b/gi, "")
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
  if (!KEY1 || !KEY2) {
    console.error("Missing UDROP_KEY1 or UDROP_KEY2 in environment.");
    process.exit(1);
  }

  console.log("🔑 Authenticating with uDrop...");
  const auth = await authorize();

  console.log("🔍 Scanning full uDrop folder tree...");
  const liveFiles = await getAllFiles(auth.token, auth.accountId, ROOT_FOLDER_ID);
  console.log(`📡 Discovered ${liveFiles.length} valid video files currently on uDrop.`);

  // Load existing database
  let oldDb = {};
  if (fs.existsSync("database.json")) {
    try {
      oldDb = JSON.parse(fs.readFileSync("database.json", "utf-8"));
      console.log(`💾 Loaded ${Object.keys(oldDb).length} existing entries from database.json.`);
    } catch (e) {
      console.warn("Could not parse existing database.json, initializing fresh.");
    }
  }

  // Build a lookup map of existing files by shortUrl or clean direct URL
  const existingByFile = new Map();
  for (const [key, item] of Object.entries(oldDb)) {
    if (item.url) {
      existingByFile.set(item.url, { key, item });
    }
  }

  const newDb = {};
  const currentLiveUrls = new Set();
  let addedCount = 0;
  let preservedCount = 0;

  for (const file of liveFiles) {
    const directUrl = `https://www.udrop.com/file/${file.shortUrl}/${encodeURIComponent(file.filename)}`;
    currentLiveUrls.add(directUrl);

    // 1. REUSE EXISTING ENTRY: If already in database, keep it untouched (no Cinemeta request)
    if (existingByFile.has(directUrl)) {
      const existing = existingByFile.get(directUrl);
      newDb[existing.key] = existing.item;
      preservedCount++;
      continue;
    }

    // 2. NEW ENTRY: Only run metadata lookup for new files
    const parsed = parseFilename(file.filename);
    console.log(`[New File] Matching metadata for: "${parsed.title}" ${parsed.year ? `(${parsed.year})` : ""}`);

    let meta = await searchCinemeta(parsed.title, parsed.year, parsed.type);
    if (!meta && parsed.type === "movie") {
      meta = await searchIMDb(parsed.title, parsed.year);
    }

    let streamKey = meta?.id || `custom_${Math.random().toString(36).substring(2, 8)}`;
    if (parsed.type === "series" && meta?.id) {
      streamKey = `${meta.id}:${parsed.season}:${parsed.episode}`;
    }

    // Resolve duplicate key collisions (e.g. multiple resolutions of same movie)
    let finalKey = streamKey;
    let counter = 1;
    while (newDb[finalKey]) {
      finalKey = `${streamKey}_${counter++}`;
    }

    const titleDisplay = parsed.type === "series"
      ? `S${parsed.season} E${parsed.episode}`
      : file.filename;

    newDb[finalKey] = {
      name: "uDrop",
      title: titleDisplay,
      url: directUrl,
      meta: {
        name: meta?.name || parsed.title,
        poster: meta?.poster || "",
        type: parsed.type
      }
    };
    addedCount++;
  }

  // 3. PRUNING: Calculate how many files were removed from uDrop
  const removedCount = Object.keys(oldDb).length - preservedCount;

  fs.writeFileSync("database.json", JSON.stringify(newDb, null, 2));

  console.log("\n================ SYNC SUMMARY ================");
  console.log(` preserved (unmodified): ${preservedCount}`);
  console.log(`➕ newly indexed:        ${addedCount}`);
  console.log(`🗑️ pruned (deleted files): ${removedCount > 0 ? removedCount : 0}`);
  console.log(`📊 total in database.json: ${Object.keys(newDb).length}`);
  console.log("==============================================");
}

run();
