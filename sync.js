import fs from "fs";
import { chromium } from "playwright";

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
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  let discoveredFiles = [];

  // Listen to background JSON/AJAX calls made by uDrop's file manager
  page.on("response", async (response) => {
    try {
      const contentType = response.headers()["content-type"] || "";
      if (contentType.includes("application/json")) {
        const json = await response.json();
        const jsonStr = JSON.stringify(json);
        const matches = jsonStr.match(/https:\\?\/\\?\/www\.udrop\.com\\?\/file\\?\/[a-zA-Z0-9_-]+\\?\/[^"'\s\\]+/g) || [];
        for (const m of matches) {
          discoveredFiles.push(m.replace(/\\\//g, "/"));
        }
      }
    } catch (e) {}
  });

  console.log(`Navigating to: ${UDROP_FOLDER_URL}`);
  await page.goto(UDROP_FOLDER_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Scroll down and wait for table/grid elements to load
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(5000);

  // Extract from HTML attributes (data-url, data-href, onclick, href)
  const domLinks = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("*"));
    const links = [];
    elements.forEach((el) => {
      const attributes = [el.getAttribute("href"), el.getAttribute("data-url"), el.getAttribute("data-href"), el.getAttribute("onclick")];
      attributes.forEach((attr) => {
        if (attr) {
          const match = attr.match(/https?:\/\/www\.udrop\.com\/file\/[a-zA-Z0-9_-]+\/[^\s"']+/);
          if (match) links.push(match[0]);
        }
      });
    });
    return links;
  });

  let fileUrls = [...new Set([...discoveredFiles, ...domLinks])];
  console.log(`Discovered ${fileUrls.length} files from folder.`);

  const database = {};

  for (let i = 0; i < fileUrls.length; i++) {
    const fileUrl = fileUrls[i];
    const rawFilename = decodeURIComponent(fileUrl.split("/").pop());
    const searchQuery = cleanTitle(rawFilename);

    console.log(`\n[${i + 1}/${fileUrls.length}] Processing: ${rawFilename}`);

    let streamUrl = fileUrl;
    try {
      await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const directInput = await page.$eval('input[id*="direct"], input[id*="download"], input[id*="file"]', (el) => el.value).catch(() => null);
      if (directInput && directInput.startsWith("http")) {
        streamUrl = directInput;
      }
    } catch (e) {}

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
