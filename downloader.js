const puppeteer = require("puppeteer-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");

const DOWNLOAD_PATH = path.resolve(__dirname, "final_downloads");
const SCREENSHOTS_PATH = path.resolve(__dirname, "debug_screenshots");
const FAILED_FOLDERS_LOG = path.resolve(__dirname, "failed_folders.txt");
const SUCCESS_LOG = path.resolve(__dirname, "successful_downloads.txt");
const STATS_LOG = path.resolve(__dirname, "download_stats.json");
const RESUME_LOG = path.resolve(__dirname, "resume_point.json");

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = "8050522429:AAHca5Cev0T3YxXo9V9qTFFSdGky1b9AQ_0";
const TELEGRAM_CHAT_ID = "6899264218";

// Dropbox share URL
const SHARE_URL =
  "https://www.dropbox.com/scl/fo/2kqin01l2ai3rpn6v7sqm/AI5FkuqK-mHT04o_oRnVDQw?rlkey=9429olqiiw06nbj9udzfaa34k&st=6mfi1tx0&dl=0";

const SELECTORS = {
  FILE_ROW_CONTAINER: 'div[role="table"] div[role="rowgroup"]',
  FILE_ROW: '[data-testid="ROW_TEST_ID"]',
  FILE_ROW_FALLBACK: [
    'div[role="row"]',
    '[data-testid*="ROW"]',
    'div[role="gridcell"]',
  ],
  HOVER_DOWNLOAD_BUTTON:
    'button[data-testid="list-item-hover-download-button"]',
  CONTINUE_BUTTON: 'button[data-dig-button="true"]',
  COOKIE_CONSENT:
    'button[data-uxa-log="privacy_consent_banner_accept_all_button"]',
  POPUP_CLOSE: 'button[aria-label="Close"]',
};

const PROGRESSIVE_SCROLL_CONFIG = {
  DOM_WAIT_DELAY: 8000,
  PRE_SCROLL_DELAY: 15000,
  SCROLL_BATCH_SIZE: 3, // Smaller batches for better stability
  SCROLL_STEP_DELAY: 5000, // Longer delays for content loading
  VERIFICATION_DELAY: 4000,
  MAX_SCROLL_ATTEMPTS: 25, // More attempts for thorough loading
  ELEMENT_LOAD_TIMEOUT: 15000, // Longer timeout for element detection
  STABLE_COUNT_THRESHOLD: 4, // More stable checks before stopping
  ENHANCED_SCROLL_THRESHOLD: 10, // When to use enhanced scroll techniques
};

// Configuration
const END_INDEX_LIMIT = 75;
const BATCH_SIZE = 75;
const DOWNLOAD_TIMEOUT = 180000; // 3 minutes
const HOVER_TIMEOUT = 15000;
const FINAL_WAIT_MINUTES = 15;

// Resume configuration
const RESUME_FROM_FILE = 1;
const FORCE_RESUME = false;

// Statistics tracking
const stats = {
  totalProcessed: 0,
  successful: 0,
  failed: 0,
  startTime: Date.now(),
  errors: [],
};

const log = async (message, level = "INFO") => {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} [${level}] ${message}`;

  console.log(logMessage);

  // Write to log file
  const logFile = path.join(__dirname, "scraper.log");
  fs.appendFileSync(logFile, logMessage + "\n");

  if (level === "ERROR") {
    stats.errors.push({ timestamp, message });
  }
};

const delay = (ms, showProgress = false) => {
  if (showProgress && ms > 5000) {
    log(`Waiting ${ms / 1000} seconds...`, "INFO");
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const sendTelegramMessage = async (message) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.sendMessage(TELEGRAM_CHAT_ID, message);
      return;
    } catch (error) {
      log(
        `Telegram send attempt ${attempt} failed: ${error.message}`,
        "WARNING"
      );
      if (attempt < maxRetries) {
        await delay(2000);
      }
    }
  }
};

const performProgressiveScroll = async (page, targetFileNumber = null) => {
  log(
    "🔄 Starting enhanced progressive scroll with comprehensive debugging",
    "INFO"
  );

  let previousElementCount = 0;
  let stableCount = 0;
  let scrollAttempts = 0;
  const maxStableChecks = PROGRESSIVE_SCROLL_CONFIG.STABLE_COUNT_THRESHOLD;

  try {
    // Wait for initial DOM load
    log("⏳ Waiting for initial DOM load...", "INFO");
    await delay(PROGRESSIVE_SCROLL_CONFIG.DOM_WAIT_DELAY, true);

    // Pre-scroll delay
    log("⏳ Pre-scroll delay for content stabilization...", "INFO");
    await delay(PROGRESSIVE_SCROLL_CONFIG.PRE_SCROLL_DELAY, true);

    while (scrollAttempts < PROGRESSIVE_SCROLL_CONFIG.MAX_SCROLL_ATTEMPTS) {
      scrollAttempts++;
      log(
        `📜 Scroll attempt ${scrollAttempts}/${PROGRESSIVE_SCROLL_CONFIG.MAX_SCROLL_ATTEMPTS}`,
        "INFO"
      );

      let currentElementCount = 0;

      try {
        log(
          "🔍 Attempting to count elements with primary selector...",
          "DEBUG"
        );

        // Wait for elements with extended timeout
        await page.waitForSelector(SELECTORS.FILE_ROW, {
          timeout: PROGRESSIVE_SCROLL_CONFIG.ELEMENT_LOAD_TIMEOUT,
        });

        // Primary method: Direct selector
        const elements = await page.$$(SELECTORS.FILE_ROW);
        currentElementCount = elements ? elements.length : 0;
        log(
          `✅ Primary selector found ${currentElementCount} elements`,
          "DEBUG"
        );

        // Fallback method: Container-based approach
        if (currentElementCount === 0) {
          log(
            "🔄 Primary selector returned 0, trying container-based approach...",
            "DEBUG"
          );
          const containerElements = await page.$$(SELECTORS.FILE_ROW_CONTAINER);

          if (containerElements.length >= 2) {
            const fileContainer = containerElements[1];
            if (fileContainer) {
              const rowsInContainer = await fileContainer.$$(
                SELECTORS.FILE_ROW
              );
              currentElementCount = rowsInContainer
                ? rowsInContainer.length
                : 0;
              log(
                `✅ Container-based count: ${currentElementCount} elements`,
                "DEBUG"
              );
            }
          }
        }

        // Additional fallback selectors
        if (currentElementCount === 0) {
          log("🔄 Trying fallback selectors...", "DEBUG");
          for (const fallbackSelector of SELECTORS.FILE_ROW_FALLBACK) {
            const fallbackElements = await page.$$(fallbackSelector);
            if (fallbackElements && fallbackElements.length > 0) {
              currentElementCount = fallbackElements.length;
              log(
                `✅ Fallback selector '${fallbackSelector}' found ${currentElementCount} elements`,
                "DEBUG"
              );
              break;
            }
          }
        }
      } catch (error) {
        log(`⚠️ Error counting elements: ${error.message}`, "WARNING");
        currentElementCount = previousElementCount; // Keep previous count to avoid infinite loop
      }

      if (currentElementCount > previousElementCount) {
        const newElements = currentElementCount - previousElementCount;
        log(
          `✅ SUCCESS: Loaded ${newElements} new elements (total: ${currentElementCount})`,
          "SUCCESS"
        );
        await sendTelegramMessage(
          `📈 Loaded ${newElements} new elements (total: ${currentElementCount})`
        );
        previousElementCount = currentElementCount;
        stableCount = 0; // Reset stable counter
      } else {
        stableCount++;
        log(
          `⏸️ No new elements loaded. Stable count: ${stableCount}/${maxStableChecks}`,
          "DEBUG"
        );

        if (stableCount >= maxStableChecks) {
          log(
            `🎯 Element count stable at ${currentElementCount}, stopping scroll`,
            "SUCCESS"
          );
          await sendTelegramMessage(
            `✅ Progressive scroll completed with ${currentElementCount} elements`
          );
          break;
        }
      }

      try {
        log("📜 Performing enhanced scroll actions...", "DEBUG");

        // Primary scroll method
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });

        await delay(PROGRESSIVE_SCROLL_CONFIG.SCROLL_STEP_DELAY);

        // Enhanced scroll techniques for stubborn content
        if (
          currentElementCount <=
            PROGRESSIVE_SCROLL_CONFIG.ENHANCED_SCROLL_THRESHOLD &&
          scrollAttempts > 3
        ) {
          log(
            "🔧 Using enhanced scroll techniques for stubborn content...",
            "DEBUG"
          );

          // Scroll specific containers
          await page.evaluate((containerSelector) => {
            const containers = document.querySelectorAll(containerSelector);
            containers.forEach((container, index) => {
              if (container && container.scrollTop !== undefined) {
                container.scrollTop = container.scrollHeight;
              }
            });
          }, SELECTORS.FILE_ROW_CONTAINER);

          await delay(2000);

          // Keyboard navigation
          await page.keyboard.press("End");
          await delay(1000);
          await page.keyboard.press("PageDown");
          await delay(1000);

          // Mouse wheel scrolling
          await page.mouse.wheel({ deltaY: 1000 });
          await delay(1000);
        }
      } catch (scrollError) {
        log(`⚠️ Scroll action failed: ${scrollError.message}`, "WARNING");
      }

      // Verification delay
      await delay(PROGRESSIVE_SCROLL_CONFIG.VERIFICATION_DELAY);

      // Progress update every 5 attempts
      if (scrollAttempts % 5 === 0) {
        await sendTelegramMessage(
          `📊 Scroll progress: ${scrollAttempts}/${PROGRESSIVE_SCROLL_CONFIG.MAX_SCROLL_ATTEMPTS} attempts, ${currentElementCount} elements loaded`
        );
      }
    }

    log(
      `🎉 Progressive scroll completed with ${previousElementCount} total elements`,
      "SUCCESS"
    );
    return previousElementCount;
  } catch (error) {
    log(`💥 Progressive scroll failed: ${error.message}`, "ERROR");
    log(`Stack trace: ${error.stack}`, "ERROR");
    await sendTelegramMessage(`💥 Progressive scroll failed: ${error.message}`);
    throw error;
  }
};

const interceptDownloadUrl = async (page, fileNumber) => {
  log(
    `🔗 Setting up enhanced network interception for file #${fileNumber}`,
    "DEBUG"
  );

  return new Promise((resolve, reject) => {
    let downloadUrlCaptured = false;
    let conflict409Detected = false;

    const timeout = setTimeout(() => {
      if (!downloadUrlCaptured && !conflict409Detected) {
        log(`⏰ Download URL capture timeout for file #${fileNumber}`, "ERROR");
        reject(new Error("Download URL capture timeout"));
      }
    }, DOWNLOAD_TIMEOUT);

    const responseHandler = async (response) => {
      const url = response.url();
      const status = response.status();

      // Skip unwanted URLs
      if (
        url.includes(".js") ||
        url.includes(".css") ||
        url.includes("analytics") ||
        url.includes("favicon")
      ) {
        return;
      }

      log(
        `🌐 Network response: ${status} ${url.substring(0, 100)}...`,
        "TRACE"
      );

      if (status === 409) {
        conflict409Detected = true;
        clearTimeout(timeout);
        page.off("response", responseHandler);
        log(`🚨 409 Conflict detected for file #${fileNumber}`, "ERROR");
        reject(new Error("409 Conflict - File may be processing"));
        return;
      }

      // Check for download URLs
      if (
        (url.includes("content_link") || url.includes("download")) &&
        (url.includes("dropboxusercontent.com") ||
          url.includes("dropbox.com")) &&
        !downloadUrlCaptured
      ) {
        downloadUrlCaptured = true;
        clearTimeout(timeout);
        page.off("response", responseHandler);

        log(
          `✅ Download URL captured for file #${fileNumber}: ${url.substring(
            0,
            100
          )}...`,
          "SUCCESS"
        );
        resolve(url);
      }
    };

    page.on("response", responseHandler);
  });
};

const processFile = async (page, client, row, fileNumber) => {
  const result = { success: false, error: null, downloadUrl: null };

  try {
    log(`🔄 Starting to process file element #${fileNumber}`, "INFO");

    // Enhanced hover with multiple attempts
    let hoverSuccess = false;
    const maxHoverAttempts = 3;

    for (let attempt = 1; attempt <= maxHoverAttempts; attempt++) {
      try {
        log(
          `🎯 Hover attempt ${attempt}/${maxHoverAttempts} for file #${fileNumber}`,
          "DEBUG"
        );

        // Get element position
        const boundingBox = await row.boundingBox();
        if (!boundingBox) {
          throw new Error("Could not get element bounding box");
        }

        const x = boundingBox.x + boundingBox.width / 2;
        const y = boundingBox.y + boundingBox.height / 2;

        log(
          `📍 Hovering over element #${fileNumber} at position (${x}, ${y})`,
          "TRACE"
        );
        await page.mouse.move(x, y);
        await delay(2000);

        hoverSuccess = true;
        break;
      } catch (hoverError) {
        log(
          `⚠️ Hover attempt ${attempt} failed: ${hoverError.message}`,
          "WARNING"
        );
        if (attempt < maxHoverAttempts) {
          await delay(2000);
        }
      }
    }

    if (!hoverSuccess) {
      throw new Error(`Failed to hover after ${maxHoverAttempts} attempts`);
    }

    // Enhanced download button detection
    let downloadButton = null;
    const maxButtonAttempts = 5;

    for (let attempt = 1; attempt <= maxButtonAttempts; attempt++) {
      try {
        log(
          `🔍 Looking for download button, attempt ${attempt}/${maxButtonAttempts}`,
          "TRACE"
        );

        downloadButton = await page.$(SELECTORS.HOVER_DOWNLOAD_BUTTON);
        if (downloadButton) {
          log(`✅ Download button found on attempt ${attempt}`, "SUCCESS");
          break;
        }

        log(
          `⚠️ Download button not found, re-hovering and waiting...`,
          "DEBUG"
        );

        // Re-hover
        const boundingBox = await row.boundingBox();
        if (boundingBox) {
          const x = boundingBox.x + boundingBox.width / 2;
          const y = boundingBox.y + boundingBox.height / 2;
          await page.mouse.move(x, y);
        }

        await delay(3000);
      } catch (buttonError) {
        log(
          `⚠️ Button search attempt ${attempt} failed: ${buttonError.message}`,
          "WARNING"
        );
      }
    }

    if (!downloadButton) {
      throw new Error(
        `Download button not found for file #${fileNumber} after ${maxButtonAttempts} attempts`
      );
    }

    // Set up network interception before clicking
    const downloadUrlPromise = interceptDownloadUrl(page, fileNumber);

    // Click download button
    log(`🖱️ Clicking download button for file #${fileNumber}`, "DEBUG");
    await downloadButton.click();

    // Wait for download URL
    const downloadUrl = await downloadUrlPromise;
    result.downloadUrl = downloadUrl;

    log(`✅ Successfully processed file #${fileNumber}`, "SUCCESS");
    result.success = true;
  } catch (error) {
    log(
      `💥 Element interaction failed for file #${fileNumber}: ${error.message}`,
      "ERROR"
    );
    result.error = error.message;
  }

  return result;
};

const downloadFileWithWget = async (url, filename, fileNumber) => {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(DOWNLOAD_PATH, filename);

    log(`⬇️ Starting download #${fileNumber}: ${filename}`, "INFO");

    const wgetArgs = [
      "--no-check-certificate",
      "--timeout=60",
      "--tries=5",
      "--continue",
      "--progress=bar:force",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "-O",
      outputPath,
      url,
    ];

    const wgetProcess = spawn("wget", wgetArgs);
    let downloadStarted = false;
    let errorOutput = "";

    wgetProcess.stdout.on("data", (data) => {
      const output = data.toString();
      if (output.includes("%") || output.includes("saved")) {
        downloadStarted = true;
      }
    });

    wgetProcess.stderr.on("data", (data) => {
      const output = data.toString();
      errorOutput += output;
      if (output.includes("%") || output.includes("saved")) {
        downloadStarted = true;
      }
    });

    wgetProcess.on("close", async (code) => {
      if (code === 0) {
        log(`✅ Download completed: ${filename}`, "SUCCESS");
        resolve();
      } else {
        log(`💥 wget failed with code ${code} for ${filename}`, "ERROR");
        log(`Error output: ${errorOutput}`, "ERROR");
        reject(new Error(`wget failed with code ${code}: ${errorOutput}`));
      }
    });

    wgetProcess.on("error", async (error) => {
      log(`💥 wget process error: ${error.message}`, "ERROR");
      reject(error);
    });

    // Enhanced timeout handling
    setTimeout(() => {
      if (!downloadStarted) {
        log(
          `⏰ Download timeout for ${filename} - killing wget process`,
          "ERROR"
        );
        wgetProcess.kill();
        reject(new Error("wget timeout - no download started"));
      }
    }, DOWNLOAD_TIMEOUT);
  });
};

const main = async () => {
  let browser = null;
  let page = null;

  try {
    // Create directories
    [DOWNLOAD_PATH, SCREENSHOTS_PATH].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    log("🚀 Starting enhanced Dropbox scraper", "INFO");
    await sendTelegramMessage("🚀 Enhanced Dropbox scraper starting...");

    // Setup Puppeteer
    puppeteer.use(stealth);

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: "/usr/bin/chromium-browser",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--allow-running-insecure-content",
        "--disable-features=VizDisplayCompositor",
        "--no-first-run",
        "--disable-default-apps",
        "--disable-popup-blocking",
        "--user-data-dir=/tmp/puppeteer-profile",
      ],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Navigate to page
    log("🌐 Navigating to Dropbox share URL", "INFO");
    await page.goto(SHARE_URL, { waitUntil: "networkidle2", timeout: 120000 });

    // Handle cookie consent
    try {
      const acceptBtn = await page.$(SELECTORS.COOKIE_CONSENT);
      if (acceptBtn) {
        await acceptBtn.click();
        await delay(2000);
        log("🍪 Cookie consent accepted", "SUCCESS");
      }
    } catch (error) {
      log(`⚠️ Cookie consent handling failed: ${error.message}`, "WARNING");
    }

    // Perform progressive scroll
    const totalElements = await performProgressiveScroll(page);
    log(
      `📊 Progressive scroll completed. Total elements: ${totalElements}`,
      "SUCCESS"
    );

    // Process files
    log("🔄 Starting file processing", "INFO");
    const rowGroups = await page.$$(SELECTORS.FILE_ROW_CONTAINER);

    if (rowGroups.length < 2) {
      throw new Error("Could not find file container");
    }

    const fileContainer = rowGroups[1];
    const allRows = await fileContainer.$$(SELECTORS.FILE_ROW);

    log(`📁 Found ${allRows.length} files to process`, "INFO");
    await sendTelegramMessage(`📁 Found ${allRows.length} files to process`);

    // Process each file
    for (let i = 0; i < Math.min(allRows.length, END_INDEX_LIMIT); i++) {
      const fileNumber = i + 1;

      try {
        log(`🔄 Processing file ${fileNumber}/${allRows.length}`, "INFO");

        const result = await processFile(page, null, allRows[i], fileNumber);

        if (result.success && result.downloadUrl) {
          const filename = `file_${fileNumber}_${Date.now()}.bin`;
          await downloadFileWithWget(result.downloadUrl, filename, fileNumber);

          stats.successful++;
          log(`✅ File ${fileNumber} completed successfully`, "SUCCESS");
        } else {
          stats.failed++;
          log(`💥 File ${fileNumber} failed: ${result.error}`, "ERROR");
        }

        stats.totalProcessed++;

        // Progress update
        if (fileNumber % 5 === 0) {
          await sendTelegramMessage(
            `📊 Progress: ${fileNumber}/${allRows.length} files processed (${stats.successful} successful, ${stats.failed} failed)`
          );
        }

        await delay(3000); // Wait between files
      } catch (error) {
        log(
          `💥 Failed to process file ${fileNumber}: ${error.message}`,
          "ERROR"
        );
        stats.failed++;
        stats.totalProcessed++;
      }
    }

    log("🎉 Scraping completed successfully", "SUCCESS");
    await sendTelegramMessage(
      `🎉 Scraping completed! Processed: ${stats.totalProcessed}, Successful: ${stats.successful}, Failed: ${stats.failed}`
    );
  } catch (error) {
    log(`💥 Main execution failed: ${error.message}`, "ERROR");
    log(`Stack trace: ${error.stack}`, "ERROR");
    await sendTelegramMessage(`💥 Scraper failed: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

// Start the scraper
main().catch(console.error);
