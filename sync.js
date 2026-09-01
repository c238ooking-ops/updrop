import fs from "fs";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

// Activate stealth plugin to pass Cloudflare bot detection
chromium.use(stealth());

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
  console.log("Launching Stealth Chromium browser...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();

  console.log(`Navigating to folder: ${UDROP_FOLDER_URL}`);
  await page.goto(UDROP_FOLDER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait for file elements to render
  console.log("Waiting for file grid / table to load...");
  try {
    await page.waitForSelector('.fileIcon, .fileListing, .file-item, tr[data-file-id], a[href*="/file/"]', { timeout: 15000 });
  } catch (e) {
    console.log("Standard selector wait timed out, continuing evaluation...");
  }

  await page.waitForTimeout(5000);

  // Deep DOM Extraction: YetiShare engine attributes + visible items
  const extractedFiles = await page.evaluate(() => {
    const results = [];
    
    // Method 1: Check all elements with data attributes
    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
      const href = el.getAttribute('href') || '';
      const url = el.getAttribute('data-url') || el.getAttribute('data-original-url') || '';
      const onclick = el.getAttribute('onclick') || '';
      
      [href, url, onclick].forEach(str => {
        const match = str.match(/https?:\/\/www\.udrop\.com\/file\/[a-zA-Z0-9_-]+\/[^"'\s)]+/);
        if (match) results.push(match[0]);
      });
    });

    // Method 2: Extract text from file rows
    const rows = document.querySelectorAll('.fileItem, tr[data-file-id], .fileListing');
    rows.forEach(row => {
      const link = row.querySelector('a');
      if (link && link.href && link.href.includes('/file/')) {
        results.push(link.href);
      }
    });

    return results;
  });

  let fileUrls = [...new Set(extractedFiles)];
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
      await page.waitForTimeout(2000);
      
      const directInput = await page.evaluate(() => {
        const el = document.querySelector('input[id*="direct"], input[id*="download"], input[value*="/file/"]');
        return el ? el.value : null;
      });

      if (directInput && directInput.startsWith("http")) {
        streamUrl = directInput;
      }
    } catch (e) {
      // Keep base fileUrl on timeout
    }

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
      console.log(`  -> No Cinemeta match for "${searchQuery}"`);
    }
  }

  await browser.close();

  fs.writeFileSync("database.json", JSON.stringify(database, null, 2));
  console.log("\nSuccessfully updated database.json!");
}

run();
