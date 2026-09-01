import fs from "fs";

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

  const lines = fs.readFileSync("links.txt", "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("http"));

  console.log(`Processing ${lines.length} links from links.txt...`);
  const database = {};

  for (const url of lines) {
    const rawFilename = decodeURIComponent(url.split("/").pop());
    const query = cleanTitle(rawFilename);

    console.log(`Matching: ${rawFilename} -> Search: "${query}"`);
    const meta = await searchCinemeta(query);

    if (meta) {
      database[meta.id] = {
        name: "uDrop Auto",
        title: rawFilename,
        url: url,
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
  console.log("Successfully generated database.json!");
}

run();
