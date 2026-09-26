import fs from "fs";

// ================= CONFIGURATION =================
let ACCOUNTS = [];

if (process.env.UDROP_ACCOUNTS_JSON) {
  try {
    ACCOUNTS = JSON.parse(process.env.UDROP_ACCOUNTS_JSON);
  } catch (e) {
    console.error("Failed to parse UDROP_ACCOUNTS_JSON:", e.message);
  }
} else if (process.env.UDROP_KEY1 && process.env.UDROP_KEY2) {
  ACCOUNTS.push({ name: "Primary Account", key1: process.env.UDROP_KEY1, key2: process.env.UDROP_KEY2 });
}

const ROOT_FOLDER_ID = process.env.UDROP_FOLDER_ID || null;
const API_BASE = "https://www.udrop.com/api/v2";
const VIDEO_EXTS = new Set(["mp4", "mkv", "avi", "webm", "ts"]);
const SEQUEL_TAGS = new Set(["2", "3", "4", "5", "6", "ii", "iii", "iv", "v", "part", "chapter", "returns", "reloaded"]);
const PART_REGEX = /(?:[._\s\-\(\[]+)(?:part|pt|cd|disc|disk)[._\s\-]*0*(\d+)/i;

// ================= UDROP API HELPERS =================
async function authorize(key1, key2) {
  const res = await fetch(`${API_BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key1, key2 })
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
  if (lower.includes("theatrical")) tags.push("Theatrical Cut");
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
    .replace(PART_REGEX, " ") 
    .replace(/[\._\-~+]/g, " ")
    .replace(/\b(theatrical|workprint|scan|35mm|70mm|vhsrip|vhs|telesync|camrip|cam)\b/gi, "")
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|hdrip|webrip|web-dl|bluray|brrip|bdrip|dvdrip|remux|open matte|extended|imax|directors cut|unrated)\b/gi, "")
    .replace(/\b(x264|x265|hevc|h264|h265|avc|10bit|aac|dts|truehd|atmos|ac3|ddp5\.1|dd5\.1|dual audio|hindi|english|subtitles|esub|subs)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseFilename(filename) {
  let clean = decodeURIComponent(filename).replace(/\.[^/.]+$/, "");

  const seriesMatch = 
    clean.match(/(.*?)\s*[sS](\d+)[eE](\d+)/i) || 
    clean.match(/(.*?)\s*(\d+)x(\d+)/i) ||
    clean.match(/(.*?)\s*Season\s*(\d+)\s*Episode\s*(\d+)/i) ||
    clean.match(/(.*?)\s*[sS](\d+)(?!e)/i);

  if (seriesMatch) {
    const titleRaw = seriesMatch[1];
    const seasonNum = parseInt(seriesMatch[2] || 1, 10);
    const episodeNum = seriesMatch[3] ? parseInt(seriesMatch[3], 10) : 1;

    return {
      type: "series",
      title: cleanGarbage(titleRaw),
      year: null,
      season: seasonNum,
      episode: episodeNum
    };
  }

  let year = null;
  let titlePart = clean;

  const bracketYear = clean.match(/[\(\[]\s*(19\d\d\vert{}20\d\d)\s*[\)\]]/);
  if (bracketYear) {
    year = parseInt(bracketYear[1], 10);
    titlePart = clean.replace(bracketYear[0], " ");
  } else {
    const leadingYear = clean.match(/^[\s\._\-]*(19\d\d|20\d\d)[\s\._\-]+([a-zA-Z].*)/);
    if (leadingYear) {
      year = parseInt(leadingYear[1], 10);
      titlePart = leadingYear[2];
    } else {
      const allYears = [...clean.matchAll(/\b(19\d\d|20\d\d)\b/g)];
      if (allYears.length > 0) {
        const lastYearMatch = allYears[allYears.length - 1];
        const beforeYear = clean.substring(0, lastYearMatch.index).trim();
        const candidateTitle = cleanGarbage(beforeYear);

        if (candidateTitle.length > 0) {
          year = parseInt(lastYearMatch[0], 10);
          titlePart = candidateTitle;
        } else {
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

function scoreCandidate(candTitle, candYearStr, targetTitle, targetYear) {
  const cYear = parseInt(candYearStr, 10);
  const tYear = targetYear ? parseInt(targetYear, 10) : null;

  if (tYear && !isNaN(cYear)) {
    if (Math.abs(cYear - tYear) > 1) return -1;
  }

  const cleanCand = normalize(candTitle);
  const cleanTarget = normalize(targetTitle);

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
        if (!item.id || !item.id.startsWith("tt")) continue;
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
    return null;
  }

  console.log(`🔎 Searching: "${parsed.title}" ${parsed.year ? `[Year: ${parsed.year}]` : ""}`);

  let match = await searchCinemeta(parsed.title, parsed.year, parsed.type);
  if (match) {
    console.log(`  ✅ [Cinemeta Matched]: ${match.name} (${match.year || ""}) -> ${match.id}`);
    return match;
  }

  match = await searchIMDb(parsed.title, parsed.year);
  if (match) {
    console.log(`  ✅ [IMDb Matched]: ${match.name} (${match.year || ""}) -> ${match.id}`);
    return match;
  }

  return null;
}

// ================= MAIN RUNNER =================
async function run() {
  if (ACCOUNTS.length === 0) {
    console.error("No uDrop credentials configured in environment.");
    process.exit(1);
  }

  let liveFiles = [];

  for (const acc of ACCOUNTS) {
    try {
      console.log(`\n🔑 Authenticating with [${acc.name}]...`);
      const auth = await authorize(acc.key1, acc.key2);
      console.log(`🔍 Scanning folder tree for [${acc.name}]...`);
      const files = await getAllFiles(auth.token, auth.accountId, ROOT_FOLDER_ID);
      console.log(`   Found ${files.length} active video files.`);
      liveFiles = liveFiles.concat(files);
    } catch (err) {
      console.error(`❌ Failed to scan ${acc.name}: ${err.message}`);
    }
  }

  console.log(`\n📡 Total pooled video files across all accounts: ${liveFiles.length}`);

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
              let storedFilename = s.filename || "";
              if (!storedFilename) {
                const parts = s.url.split("/");
                storedFilename = decodeURIComponent(parts[parts.length - 1]);
              }

              let currentPoster = entry.meta?.poster || "";
              if (key.startsWith("tt")) {
                currentPoster = `https://images.metahub.space/poster/medium/${key.split(":")[0]}/img`;
              }

              cachedStreams.set(shortId, {
                key: key,
                meta: {
                  ...entry.meta,
                  poster: currentPoster
                },
                streamTitle: s.title,
                filename: storedFilename,
                duration: s.duration || null,
                size: s.size || s.fileSize || null
              });
            }
          }
        }
      }
      console.log(`💾 Cache contains ${cachedStreams.size} valid items with preserved properties.`);
    } catch (e) {
      console.log("No valid existing database found. Building fresh.");
    }
  }

  const newDb = {};
  let reusedCount = 0;
  let updatedCount = 0;
  let newAddedCount = 0;

  for (const file of liveFiles) {
    const directUrl = `https://www.udrop.com/file/${file.shortUrl}/${encodeURIComponent(file.filename)}`;
    const edition = getEditionTag(file.filename);

    const cached = cachedStreams.get(file.shortUrl);
    if (cached && cached.filename === file.filename) {
      const key = cached.key;

      if (!newDb[key]) {
        newDb[key] = { meta: cached.meta, streams: [] };
      }

      const streamExists = newDb[key].streams.some(s => s.url === directUrl);
      if (!streamExists) {
        const item = {
          name: "uDrop",
          title: cached.streamTitle || `${cached.meta.name} [${edition}]`,
          url: directUrl,
          filename: file.filename
        };
        if (cached.duration) item.duration = cached.duration;
        if (cached.size) item.size = cached.size;

        newDb[key].streams.push(item);
      }
      reusedCount++;
      continue;
    }

    if (cached && cached.filename !== file.filename) {
      updatedCount++;
    } else {
      newAddedCount++;
    }

    const parsed = parseFilename(file.filename);
    const meta = await resolveMetadata(parsed);

    let streamKey = meta?.id || `custom_${normalize(parsed.title)}`;
    if (parsed.type === "series" && meta?.id) {
      streamKey = `${meta.id}:${parsed.season}:${parsed.episode}`;
    } else if (parsed.type === "series") {
      streamKey = `custom_${normalize(parsed.title)}:s${parsed.season}`;
    }

    const standardizedPoster = (meta?.id && meta.id.startsWith("tt"))
      ? `https://images.metahub.space/poster/medium/${meta.id}/img`
      : (meta?.poster || "");

    if (!newDb[streamKey]) {
      newDb[streamKey] = {
        meta: {
          name: meta?.name || parsed.title,
          poster: standardizedPoster,
          type: parsed.type
        },
        streams: []
      };
    }

    const displayTitle = parsed.type === "series"
      ? `${meta?.name || parsed.title} S${parsed.season} E${parsed.episode} [${edition}]`
      : `${meta?.name || parsed.title} [${edition}]`;

    const streamExists = newDb[streamKey].streams.some(s => s.url === directUrl);
    if (!streamExists) {
      const newItem = {
        name: "uDrop",
        title: displayTitle,
        url: directUrl,
        filename: file.filename
      };
      
      if (cached && cached.duration) newItem.duration = cached.duration;
      if (cached && cached.size) newItem.size = cached.size;
      else if (file.fileSize) newItem.size = parseInt(file.fileSize, 10);

      newDb[streamKey].streams.push(newItem);
    }
  }

  for (const entry of Object.values(newDb)) {
    if (entry.streams && entry.streams.length > 1) {
      entry.streams.sort((a, b) => {
        const pA = (a.filename || a.url).match(PART_REGEX);
        const pB = (b.filename || b.url).match(PART_REGEX);
        const numA = pA ? parseInt(pA[1], 10) : 0;
        const numB = pB ? parseInt(pB[1], 10) : 0;
        return numA - numB;
      });
    }
  }

  fs.writeFileSync("database.json", JSON.stringify(newDb, null, 2));

  console.log("\n================ SYNC SUMMARY ================");
  console.log(`♻️  Reused from cache:   ${reusedCount}`);
  console.log(`🔄 Re-indexed (renamed): ${updatedCount}`);
  console.log(`➕ Newly indexed files: ${newAddedCount}`);
  console.log(`📦 Active titles in DB:  ${Object.keys(newDb).length}`);
  console.log("==============================================");
}

run();
