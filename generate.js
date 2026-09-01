import fs from "fs";

function normalizeLink(url) {
  let cleanUrl = url.trim();
  if (cleanUrl.includes("udrop.com/") && !cleanUrl.includes("udrop.com/file/")) {
    return cleanUrl.replace(/udrop\.com\//i, "udrop.com/file/");
  }
  return cleanUrl;
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
    console.error("links.txt file not found!");
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
    const query = cleanTitle(rawFilename);

    console.log(`Processing: "${query}"...`);
    const meta = await searchCinemeta(query);

    const imdbId = meta?.id || `custom_${Math.random().toString(36).substring(2, 8)}`;
    const movieName = meta?.name || query;
    const posterUrl = meta?.poster || "";

    output += `  // ${movieName}\n`;
    output += `  "${imdbId}": {\n`;
    output += `    name: "uDrop",\n`;
    output += `    title: "${rawFilename}",\n`;
    output += `    url: "${directUrl}",\n`;
    output += `    meta: {\n`;
    output += `      name: "${movieName.replace(/"/g, '\\"')}",\n`;
    output += `      poster: "${posterUrl}",\n`;
    output += `      type: "movie"\n`;
    output += `    }\n`;
    output += `  },\n`;
  }

  output += "};\n";

  // Save to file and write to GitHub Actions summary for one-click copy
  fs.writeFileSync("cloudflare_code.js", output);
  
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Copy This Into Cloudflare Worker:\n\`\`\`javascript\n${output}\`\`\`\n`
    );
  }

  console.log("\nDone! Output generated in cloudflare_code.js");
}

run();
