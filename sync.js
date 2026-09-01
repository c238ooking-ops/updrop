import fs from "fs";

// Automatically injects /file/ if missing
function normalizeUdropLink(url) {
  let cleanUrl = url.trim();
  
  // If it already has /file/, keep it as is
  if (cleanUrl.includes("udrop.com/file/")) {
    return cleanUrl;
  }
  
  // Replace https://www.udrop.com/XYZ/movie.mp4 -> https://www.udrop.com/file/XYZ/movie.mp4
  return cleanUrl.replace(/https?:\/\/(?:www\.)?udrop\.com\/(?!file\/)/i, "https://www.udrop.com/file/");
}

function cleanTitle(filename) {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[\._\(\)\[\]\-~]/g, " ")
    .replace(/\b(1080p|720p|480p|4k|2160p|1440p|bluray|web-dl|dvdrip|brrip|hdrip|x264|x265|hevc|aac|dts|remux|scan|open\s*matte)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchCinemeta(query) {
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`);
    const data = await res.json();
    if (data && data.metas && data.metas.length > 0) {
      return data.metas[0];
    }
  } catch (err) {
    console.error(`Error searching Cinemeta: ${err.message}`);
  }
  return null;
}

async function run() {
  if (!fs.existsSync("links.txt")) {
    console.error("links.txt not found!");
    process.exit(1);
  }

  const rawLines = fs.readFileSync("links.txt", "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("http"));

  console.log(`Processing ${rawLines.length} links from links.txt...`);
  const database = {};

  for (const rawUrl of rawLines) {
    // 1. Auto-insert /file/ if missing
    const directUrl = normalizeUdropLink(rawUrl);
    const rawFilename = decodeURIComponent(directUrl.split("/").pop());
    const query = cleanTitle(rawFilename);

    console.log(`Processing: ${rawFilename}`);
    console.log(`  -> Direct Link: ${directUrl}`);

    const meta = await searchCinemeta(query);

    if (meta) {
      database[meta.id] = {
        name: "uDrop Auto",
        title: rawFilename,
        url: directUrl,
        meta: {
          name: meta.name,
          poster: meta.poster || "",
          year: meta.year || ""
        }
      };
      console.log(`  -> Matched: ${meta.name} (${meta.id})`);
    } else {
      console.log(`  -> No match for "${query}"`);
    }
  }

  fs.writeFileSync("database.json", JSON.stringify(database, null, 2));
  console.log("Successfully generated database.json with direct links!");
}

run();
