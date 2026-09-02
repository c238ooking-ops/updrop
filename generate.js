import fs from "fs";

// Configuration
const ROOT_FOLDER_ID = process.env.UDROP_FOLDER_ID || null; // null crawls entire account
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

// Recursively lists all files across all folders and subfolders
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
        if (VIDEO_EXTS.has(file.extension?.toLowerCase())) {
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
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|web-dl|bluray|remux)\b/gi, "")
    .replace(/\b(x264|x265|hevc|aac|dts|dual audio|hindi|english)\b/gi, "")
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

async function run() {
  if (!KEY1 || !KEY2) {
    console.error("Missing UDROP_KEY1 or UDROP_KEY2 in environment.");
    process.exit(1);
  }

  console.log("🔑 Authenticating with uDrop...");
  const auth = await authorize();

  console.log("🔍 Scanning uDrop directory structure...");
  const files = await getAllFiles(auth.token, auth.accountId, ROOT_FOLDER_ID);
  console.log(`Found ${files.length} total video files.`);

  let db = {};
  if (fs.existsSync("database.json")) {
    try {
      db = JSON.parse(fs.readFileSync("database.json", "utf-8"));
    } catch (e) {}
  }

  const existingUrls = new Set(Object.values(db).map(e => e.url));
  let added = 0;

  for (const file of files) {
    const directUrl = `https://www.udrop.com/file/${file.shortUrl}/${encodeURIComponent(file.filename)}`;

    // Skip if already in database
    if (existingUrls.has(directUrl)) continue;

    const parsed = parseFilename(file.filename);
    console.log(`[New Item] Matching: ${parsed.title}...`);
    const meta = await searchCinemeta(parsed.title, parsed.year, parsed.type);

    let streamKey = meta?.id || `custom_${Math.random().toString(36).substring(2, 8)}`;
    if (parsed.type === "series" && meta?.id) {
      streamKey = `${meta.id}:${parsed.season}:${parsed.episode}`;
    }

    const titleDisplay = parsed.type === "series" 
      ? `S${parsed.season} E${parsed.episode}` 
      : file.filename;

    db[streamKey] = {
      name: "uDrop",
      title: titleDisplay,
      url: directUrl,
      meta: {
        name: meta?.name || parsed.title,
        poster: meta?.poster || "",
        type: parsed.type
      }
    };
    existingUrls.add(directUrl);
    added++;
  }

  fs.writeFileSync("database.json", JSON.stringify(db, null, 2));
  console.log(`Sync complete! Added ${added} new files. Total: ${Object.keys(db).length}`);
}

run();
