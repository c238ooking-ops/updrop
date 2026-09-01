import fs from "fs";

function normalizeLink(url) {
  let cleanUrl = url.trim();
  if (cleanUrl.includes("udrop.com/") && !cleanUrl.includes("udrop.com/file/")) {
    return cleanUrl.replace(/udrop\.com\//i, "udrop.com/file/");
  }
  return cleanUrl;
}

function parseFilename(filename) {
  const cleanName = filename.replace(/\.[^/.]+$/, "").replace(/[\._\-~]/g, " ");
  // Matches S01E01, s1e1, 1x01, etc.
  const seriesMatch = cleanName.match(/(.*?)\s*[sS](\d+)[eE](\d+)/i) || cleanName.match(/(.*?)\s*(\d+)x(\d+)/i);

  if (seriesMatch) {
    return {
      type: "series",
      query: seriesMatch[1].trim(),
      season: parseInt(seriesMatch[2], 10),
      episode: parseInt(seriesMatch[3], 10)
    };
  }

  return {
    type: "movie",
    query: cleanName
      .replace(/\b(1080p|720p|480p|4k|2160p|bluray|web-dl|dvdrip|x264|x265|hevc|aac)\b/gi, "")
      .trim()
  };
}

async function searchCinemeta(query, type) {
  try {
    const catalogType = type === "series" ? "series" : "movie";
    const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${catalogType}/top/search=${encodeURIComponent(query)}.json`);
    const data = await res.json();
    if (data?.metas?.length > 0) return data.metas[0];
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

  let output = "const STREAMS_DB = {\n";

  for (const rawUrl of rawLines) {
    const directUrl = normalizeLink(rawUrl);
    const rawFilename = decodeURIComponent(directUrl.split("/").pop());
    const parsed = parseFilename(rawFilename);

    console.log(`Processing: "${parsed.query}" (${parsed.type})`);
    const meta = await searchCinemeta(parsed.query, parsed.type);

    let streamKey = meta?.id || `custom_${Math.random().toString(36).substring(2, 8)}`;
    if (parsed.type === "series" && meta?.id) {
      streamKey = `${meta.id}:${parsed.season}:${parsed.episode}`;
    }

    const titleDisplay = parsed.type === "series"
      ? `S${parsed.season} E${parsed.episode}`
      : rawFilename;

    output += `  // ${meta?.name || parsed.query} ${parsed.type === "series" ? `S${parsed.season}E${parsed.episode}` : ""}\n`;
    output += `  "${streamKey}": {\n`;
    output += `    name: "uDrop",\n`;
    output += `    title: "${titleDisplay}",\n`;
    output += `    url: "${directUrl}",\n`;
    output += `    meta: {\n`;
    output += `      name: "${(meta?.name || parsed.query).replace(/"/g, '\\"')}",\n`;
    output += `      poster: "${meta?.poster || ""}",\n`;
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
