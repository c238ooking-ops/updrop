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

// Extract human-readable version/edition tag from filename
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
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|webrip|web-dl|bluray|remux|open matte|extended|imax)\b/gi, "")
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
    console.error("Missing UDROP_KEY1 or UDROP_KEY2.");
    process.exit(1);
  }

  const auth = await authorize();
  const liveFiles = await getAllFiles(auth.token, auth.accountId, ROOT_FOLDER_ID);

  // Load existing database
  let oldDb = {};
  if (fs.existsSync("database.json")) {
    try {
      oldDb = JSON.parse(fs.readFileSync("database.json", "utf-8"));
    } catch (e) {}
  }

  // Index existing streams by file URL to reuse matched metadata
  const cachedStreamsByUrl = new Map();
  for (const [key, entry] of Object.entries(oldDb)) {
    const streams = Array.isArray(entry.streams) ? entry.streams : [entry];
    for (const s of streams) {
      if (s.url) cachedStreamsByUrl.set(s.url, { key, meta: entry.meta, stream: s });
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

    // New item lookup
    const parsed = parseFilename(file.filename);
    let meta = await searchCinemeta(parsed.title, parsed.year, parsed.type);
    if (!meta && parsed.type === "movie") {
      meta = await searchIMDb(parsed.title, parsed.year);
    }

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
  console.log(`Synced! Database contains ${Object.keys(newDb).length} titles/episodes.`);
}

run();
