import fs from "fs";
import { chromium } from "playwright";

// Put your exact uDrop folder or profile link here
const UDROP_FOLDER_URL = "https://www.udrop.com/folder/55aadbef3484e0d08a583dd6016f5ace/M";

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
    console.error(`Cinemeta error for "${query}":`, err.message);
  }
  return null;
}

async function run() {
  console.log("Launching headless browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  console.log(`Navigating to: ${UDROP_FOLDER_URL}`);
  await page.goto(UDROP_FOLDER_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Wait extra seconds for client-side JS tables/grids to populate
  await page.waitForTimeout(3000);

  // Extract all file links and folder links on page
  const pageLinks = await page.$$eval("a", (anchors) => anchors.map((a) => a.href));
  
  // Find all file URLs (udrop.com/file/...)
  let fileUrls = pageLinks.filter((href) => href.includes("udrop.com/file/"));

  // Check if there are subfolders on the page and enter them
  const folderUrls = pageLinks.filter((href) => href.includes("udrop.com/folder/") || href.includes("/users/"));
  for (const folder of [...new Set(folderUrls)]) {
    if (folder !== UDROP_FOLDER_URL) {
      try {
        console.log(`Scanning subfolder: ${folder}`);
        await page.goto(folder, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(2000);
        const subLinks = await page.$$eval("a", (anchors) => anchors.map((a) => a.href));
        const subFiles = subLinks.filter((href) => href.includes("udrop.com/file/"));
        fileUrls.push(...subFiles);
      } catch (e) {
        console.log(`Failed loading folder ${folder}`);
      }
    }
  }

  fileUrls = [...new Set(fileUrls)];
  console.log(`Found ${fileUrls.length} file links.`);

  const database = {};

  for (let i = 0; i < fileUrls.length; i++) {
    const fileUrl = fileUrls[i];
    const rawFilename = decodeURIComponent(fileUrl.split("/").pop());
    const searchQuery = cleanTitle(rawFilename);

    console.log(`\n[${i + 1}/${fileUrls.length}] Processing: ${rawFilename}`);
    
    // Visit the file page to extract direct link if available
    let streamUrl = fileUrl;
    try {
      await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const directInput = await page.$eval('input[id*="direct"], input[id*="download"], input[id*="file"]', (el) => el.value).catch(() => null);
      if (directInput && directInput.startsWith("http")) {
        streamUrl = directInput;
      }
    } catch (e) {
      // Fallback to the fileUrl
    }

    // Lookup metadata in Cinemeta
    const meta = await searchCinemeta(searchQuery);
    if (meta) {
      console.log(`  -> Matched: ${meta.name} (${meta.id})`);
      database[meta.id] = {
        name: "uDrop Auto",
        title: rawFilename,
        url: streamUrl,
        meta: {
          name: meta.name,
          poster: meta.poster || "",
          year: meta.year || ""
        }
      };
    } else {
      console.log(`  -> No Cinemeta match found for "${searchQuery}"`);
    }
  }

  await browser.close();

  fs.writeFileSync("database.json", JSON.stringify(database, null, 2));
  console.log("\nSuccessfully generated database.json with all files!");
}

run();
