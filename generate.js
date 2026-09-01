import fs from "fs";

// 1. Direct URL Normalizer
function normalizeLink(url) {
  let cleanUrl = url.trim();
  if (cleanUrl.includes("udrop.com/") && !cleanUrl.includes("udrop.com/file/")) {
    return cleanUrl.replace(/udrop\.com\//i, "udrop.com/file/");
  }
  return cleanUrl;
}

// 2. High-Precision Media & Metadata Parser
function parseFilename(filename) {
  let name = decodeURIComponent(filename)
    .replace(/\.[^/.]+$/, "") // Strip file extension
    .replace(/[\[\(\{].*?[\]\)\}]/g, " ") // Strip brackets/parentheses content first
    .replace(/[\._\-~+]/g, " "); // Replace separators with spaces

  // Detect Series (S01E01, 1x01, Season 1 Episode 1)
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

  // Detect Release Year (1900-2099)
  let year = null;
  const yearMatch = name.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    year = yearMatch[1];
    // Keep only the part of the title before the year
    name = name.substring(0, name.indexOf(yearMatch[0]));
  }

  // Strip quality tags, codecs, and release group junk
  const cleanTitle = name
    .replace(/\b(4k|2160p|1440p|1080p|720p|480p|576p|hdrip|webrip|web-dl|web|bluray|brrip|bdrip|dvdrip|remux|scan|open matte|extended|unrated|directors cut)\b/gi, "")
    .replace(/\b(x264|x265|hevc|h264|h265|avc|10bit|aac|dts|dts-hd|truehd|atmos|ac3|ddp5\.1|dd5\.1|dual audio|hindi|english|esub)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    type: "movie",
    title: cleanTitle,
    year: year
  };
}

// --- Metadata Search Engines ---

// Provider A: Cinemeta
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
  } catch (e) {
    // Failover
  }
  return null;
}

// Provider B: IMDb Direct Suggestion Engine
async function searchIMDb(title, year) {
  try {
    const query = cleanQuery(title);
    const firstLetter = query.charAt(0).toLowerCase();
    const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();

    if (data?.d?.length > 0) {
      // Find exact or closest movie match
      const candidates = data.d.filter(item => item.id && item.id.startsWith("tt"));
      if (year) {
        const exact = candidates.find(item => item.y == year);
        if (exact) {
          return {
            id: exact.id,
            name: exact.l,
            year: exact.y,
            poster: exact.i?.imageUrl || ""
          };
        }
      }
      const top = candidates[0];
      if (top) {
        return {
          id: top.id,
          name: top.l,
          year: top.y,
          poster: top.i?.imageUrl || ""
        };
      }
    }
  } catch (e) {
    // Failover
  }
  return null;
}

function cleanQuery(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Unified Fallback Search
async function findMetadata(parsed) {
  console.log(`Searching: "${parsed.title}" ${parsed.year ? `(${parsed.year})` : ""}`);

  // 1. Try Cinemeta First
  let meta = await searchCinemeta(parsed.title, parsed.year, parsed.type);
  if (meta) {
    console.log(`  -> [Cinemeta Matched]: ${meta.name} (${meta.id})`);
    return meta;
  }

  // 2. Fallback to IMDb Suggestion Engine
  if (parsed.type === "movie") {
    meta = await searchIMDb(parsed.title, parsed.year);
    if (meta) {
      console.log(`  -> [IMDb Matched]: ${meta.name} (${meta.id})`);
      return meta;
    }
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

  let output = "const STREAMS_DB = {\n";

  for (const rawUrl of rawLines) {
    const directUrl = normalizeLink(rawUrl);
    const rawFilename = decodeURIComponent(directUrl.split("/").pop());
    const parsed = parseFilename(rawFilename);

    const meta = await findMetadata(parsed);

    let streamKey = meta?.id || `custom_${Math.random().toString(36).substring(2, 8)}`;
    if (parsed.type === "series" && meta?.id) {
      streamKey = `${meta.id}:${parsed.season}:${parsed.episode}`;
    }

    const titleDisplay = parsed.type === "series"
      ? `S${parsed.season} E${parsed.episode}`
      : rawFilename;

    const finalName = meta?.name || parsed.title;
    const finalPoster = meta?.poster || "";

    output += `  // ${finalName} ${parsed.year ? `(${parsed.year})` : ""} ${parsed.type === "series" ? `S${parsed.season}E${parsed.episode}` : ""}\n`;
    output += `  "${streamKey}": {\n`;
    output += `    name: "uDrop",\n`;
    output += `    title: "${titleDisplay}",\n`;
    output += `    url: "${directUrl}",\n`;
    output += `    meta: {\n`;
    output += `      name: "${finalName.replace(/"/g, '\\"')}",\n`;
    output += `      poster: "${finalPoster}",\n`;
    output += `      type: "${parsed.type}"\n`;
    output += `    }\n`;
    output += `  },\n`;
  }

  output += "};\n";

  fs.writeFileSync("cloudflare_code.js", output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Copy This Into Cloudflare Worker:\n\`\`\`javascript\n${output}\`\`\`\n`
    );
  }

  console.log("\nDone! Cloudflare code generated.");
}

run();
