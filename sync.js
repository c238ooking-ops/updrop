import fs from 'fs';

// Set your uDrop public folder URL or shared link here
const UDROP_FOLDER_URL = "https://www.udrop.com/shared/5x54xh0ip3-wegrd5mf71q_msgvz37le4i6ud9s1izg9gf3kia-nsmfjyc9txluwa95_eblwefhw-l-kopn6wumtujwmi3gwhbdkkacmrlyq4l7ltxbo-llja1aycknp";

// Clean filename to search IMDb/Cinemeta (e.g., "Spider-Man_2002_1080p.mkv" -> "Spider Man")
function cleanTitle(filename) {
  return filename
    .replace(/\.[^/.]+$/, "") // remove extension
    .replace(/[\._\(\)\[\]\-]/g, " ") // replace symbols with spaces
    .replace(/\b(1080p|720p|4k|2160p|1440p|bluray|web-dl|dvdrip|x264|x265|aac|scan|remux)\b/gi, "")
    .trim();
}

async function searchCinemeta(cleanName) {
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(cleanName)}.json`);
    const data = await res.json();
    if (data && data.metas && data.metas.length > 0) {
      return data.metas[0]; // Best match
    }
  } catch (e) {
    console.error(`Error searching Cinemeta for: ${cleanName}`, e);
  }
  return null;
}

async function run() {
  console.log("Fetching uDrop folder...");
  
  // Scrape page HTML for file links
  const html = await (await fetch(UDROP_FOLDER_URL)).text();
  
  // Regex to match uDrop file download URLs
  const fileRegex = /https:\/\/www\.udrop\.com\/file\/[a-zA-Z0-9_-]+\/[^"'\s]+/g;
  const matches = [...new Set(html.match(fileRegex) || [])];

  console.log(`Found ${matches.length} files on uDrop.`);
  const db = {};

  for (const fileUrl of matches) {
    const filename = decodeURIComponent(fileUrl.split('/').pop());
    const query = cleanTitle(filename);
    
    console.log(`Matching: ${filename} -> Search: "${query}"`);
    const meta = await searchCinemeta(query);

    if (meta) {
      db[meta.id] = {
        name: "uDrop Auto",
        title: filename,
        url: fileUrl,
        meta: {
          name: meta.name,
          poster: meta.poster,
          year: meta.year
        }
      };
      console.log(`-> Mapped to ${meta.name} (${meta.id})`);
    } else {
      console.log(`-> No IMDb match found for "${filename}"`);
    }
  }

  fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
  console.log("Successfully generated database.json!");
}

run();
