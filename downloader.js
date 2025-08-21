require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { MongoClient } = require("mongodb");
const TelegramBot = require("node-telegram-bot-api");
const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

// Configuration from environment
const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  dropbox: {
    shareUrl: process.env.SHARE_URL,
  },
  mongodb: {
    uri: process.env.MONGODB_URI,
    dbName: process.env.DATABASE_NAME,
    failedCollection: process.env.FAILED_COLLECTION,
  },
  paths: {
    download: process.env.DOWNLOAD_PATH,
    screenshots: process.env.SCREENSHOTS_PATH,
  },
  limits: {
    maxFoldersPerSession: parseInt(process.env.MAX_FOLDERS_PER_SESSION || 50),
    batchSize: parseInt(process.env.BATCH_SIZE || 75),
  },
  delays: {
    domWait: parseInt(process.env.DOM_WAIT_DELAY || 6000),
    preScroll: parseInt(process.env.PRE_SCROLL_DELAY || 12000),
    scrollStep: parseInt(process.env.SCROLL_STEP_DELAY || 3000),
    verification: parseInt(process.env.VERIFICATION_DELAY || 3000),
    downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT || 30000),
  },
  browser: {
    headless: process.env.HEADLESS === "true",
    userDataDir: process.env.USER_DATA_DIR,
  },
};

// Selectors (kept from old script)
const SELECTORS = {
  FILE_ROW_CONTAINER: 'div[role="table"] div[role="rowgroup"]',
  FILE_ROW: '[data-testid="ROW_TEST_ID"]',
  HOVER_DOWNLOAD_BUTTON:
    'button[data-testid="list-item-hover-download-button"]',
  CONTINUE_BUTTON: 'button[data-dig-button="true"]',
  COOKIE_CONSENT:
    'button[data-uxa-log="privacy_consent_banner_accept_all_button"]',
  POPUP_CLOSE: 'button[aria-label="Close"]',
};

// Initialize services
puppeteer.use(stealth);
const bot = new TelegramBot(config.telegram.token, { polling: true });
let mongoClient = null;
let db = null;

// Statistics tracking
const stats = {
  totalProcessed: 0,
  successfulDownloads: 0,
  failedDownloads: 0,
  conflictErrors: 0,
  startTime: Date.now(),
  resumePoint: 0,
};

// Logger utility
class Logger {
  static async log(message, type = "INFO") {
    const timestamp = new Date().toISOString();
    const colorMap = {
      INFO: "\x1b[36m",
      SUCCESS: "\x1b[32m",
      ERROR: "\x1b[31m",
      WARNING: "\x1b[33m",
      DEBUG: "\x1b[35m",
    };
    const color = colorMap[type] || "\x1b[0m";
    console.log(`${timestamp} ${color}[${type}]\x1b[0m ${message}`);
  }

  static async error(message) {
    await this.log(message, "ERROR");
  }

  static async success(message) {
    await this.log(message, "SUCCESS");
  }

  static async warning(message) {
    await this.log(message, "WARNING");
  }

  static async debug(message) {
    await this.log(message, "DEBUG");
  }
}

// MongoDB connection
async function connectMongoDB() {
  try {
    mongoClient = new MongoClient(config.mongodb.uri);
    await mongoClient.connect();
    db = mongoClient.db(config.mongodb.dbName);
    await Logger.success("Connected to MongoDB");

    // Create indexes
    const collection = db.collection(config.mongodb.failedCollection);
    await collection.createIndex({ url: 1 });
    await collection.createIndex({ timestamp: -1 });
  } catch (error) {
    await Logger.error(`MongoDB connection failed: ${error.message}`);
    throw error;
  }
}

// Save failed download to MongoDB
async function saveFailedDownload(url, fileNumber, error, folderHref = null) {
  try {
    const collection = db.collection(config.mongodb.failedCollection);

    // Check if already exists to avoid duplicates
    const existing = await collection.findOne({ url, error });
    if (existing) {
      await Logger.debug(`Duplicate failed download not saved: ${url}`);
      return;
    }

    await collection.insertOne({
      url,
      folderHref,
      fileNumber,
      error,
      timestamp: new Date(),
      retried: false,
    });

    await Logger.log(`Failed download saved to MongoDB: ${url}`, "WARNING");
  } catch (err) {
    await Logger.error(`Error saving failed download: ${err.message}`);
  }
}

// Resume point management
async function saveResumePoint(fileNumber) {
  try {
    const resumeData = {
      lastProcessedFile: fileNumber,
      timestamp: new Date().toISOString(),
      stats: { ...stats },
    };

    await fs.writeFile(
      "resume_point.json",
      JSON.stringify(resumeData, null, 2)
    );
    stats.resumePoint = fileNumber;
  } catch (error) {
    await Logger.error(`Error saving resume point: ${error.message}`);
  }
}

async function loadResumePoint() {
  try {
    const data = await fs.readFile("resume_point.json", "utf8");
    const resumeData = JSON.parse(data);
    await Logger.log(
      `Resume point loaded: Starting from file #${
        resumeData.lastProcessedFile + 1
      }`
    );
    return resumeData.lastProcessedFile + 1;
  } catch (error) {
    await Logger.log("No resume point found, starting from beginning");
    return 1;
  }
}

// Telegram notifications
async function sendTelegramMessage(message, parseMode = null) {
  try {
    const options = parseMode ? { parse_mode: parseMode } : {};
    await bot.sendMessage(config.telegram.chatId, message, options);
    await Logger.log(`Telegram message sent: ${message.substring(0, 50)}...`);
  } catch (error) {
    await Logger.error(`Failed to send Telegram message: ${error.message}`);
  }
}

async function sendTelegramPhoto(photoPath, caption = "") {
  try {
    await bot.sendPhoto(config.telegram.chatId, photoPath, { caption });
    await Logger.log("Telegram photo sent");
  } catch (error) {
    await Logger.error(`Failed to send Telegram photo: ${error.message}`);
  }
}

// Telegram bot commands
bot.onText(/\/status/, async (msg) => {
  try {
    const cpuUsage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const statusMessage =
      `📊 *VPS Status*\n\n` +
      `CPU Usage: ${Math.round(cpuUsage.user / 1000000)}s user, ${Math.round(
        cpuUsage.system / 1000000
      )}s system\n` +
      `Memory: ${(usedMem / 1024 / 1024 / 1024).toFixed(2)}GB / ${(
        totalMem /
        1024 /
        1024 /
        1024
      ).toFixed(2)}GB (${Math.round((usedMem / totalMem) * 100)}%)\n` +
      `Process Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB\n` +
      `Uptime: ${Math.round(process.uptime() / 60)} minutes\n\n` +
      `📈 *Download Stats*\n` +
      `Total Processed: ${stats.totalProcessed}\n` +
      `Successful: ${stats.successfulDownloads}\n` +
      `Failed: ${stats.failedDownloads}\n` +
      `409 Conflicts: ${stats.conflictErrors}`;

    await bot.sendMessage(msg.chat.id, statusMessage, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `Error getting status: ${error.message}`
    );
  }
});

bot.onText(/\/screenshot/, async (msg) => {
  try {
    if (global.currentPage) {
      const screenshotPath = path.join(
        config.paths.screenshots,
        `command_screenshot_${Date.now()}.png`
      );
      await global.currentPage.screenshot({
        path: screenshotPath,
        fullPage: true,
      });
      await bot.sendPhoto(msg.chat.id, screenshotPath, {
        caption: "Current browser state",
      });
    } else {
      await bot.sendMessage(msg.chat.id, "No active browser session");
    }
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `Error taking screenshot: ${error.message}`
    );
  }
});

bot.onText(/\/sh (.+)/, async (msg, match) => {
  try {
    const command = match[1];
    const { stdout, stderr } = await execAsync(command);
    const output = stdout || stderr || "Command executed with no output";

    // Limit output length for Telegram
    const truncatedOutput =
      output.length > 3000 ? output.substring(0, 3000) + "..." : output;
    await bot.sendMessage(msg.chat.id, `\`\`\`\n${truncatedOutput}\n\`\`\``, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `Error executing command: ${error.message}`
    );
  }
});

bot.onText(/\/count/, async (msg) => {
  try {
    const files = await fs.readdir(config.paths.download);
    const validFiles = files.filter(
      (f) => !f.startsWith(".") && !f.endsWith(".crdownload")
    );
    await bot.sendMessage(
      msg.chat.id,
      `📁 Files in download folder: ${validFiles.length}`
    );
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `Error counting files: ${error.message}`
    );
  }
});

bot.onText(/\/failed/, async (msg) => {
  try {
    const collection = db.collection(config.mongodb.failedCollection);
    const failedCount = await collection.countDocuments();
    const recentFailed = await collection
      .find()
      .sort({ timestamp: -1 })
      .limit(5)
      .toArray();

    let message = `❌ Failed downloads: ${failedCount}\n\n`;
    if (recentFailed.length > 0) {
      message += `Recent failures:\n`;
      recentFailed.forEach((item, index) => {
        message += `${index + 1}. ${item.error} - ${new Date(
          item.timestamp
        ).toLocaleString()}\n`;
      });
    }

    await bot.sendMessage(msg.chat.id, message);
  } catch (error) {
    await bot.sendMessage(
      msg.chat.id,
      `Error getting failed downloads: ${error.message}`
    );
  }
});

// Download with wget
async function downloadWithWget(downloadUrl, filename, fileNumber) {
  return new Promise((resolve, reject) => {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const ext = path.extname(filename) || ".zip";
    const baseName = path.basename(filename, ext);
    const finalFilename = `${baseName}_${randomSuffix}${ext}`;
    const outputPath = path.join(config.paths.download, finalFilename);

    const wgetArgs = [
      downloadUrl,
      "-O",
      outputPath,
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "--timeout=60",
      "--tries=3",
      "--continue",
    ];

    const wgetProcess = spawn("wget", wgetArgs);
    let downloadStarted = false;

    wgetProcess.stderr.on("data", (data) => {
      const output = data.toString();
      if (output.includes("%") || output.includes("saved")) {
        downloadStarted = true;
      }
    });

    wgetProcess.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, filename: finalFilename });
      } else {
        reject(new Error(`wget failed with exit code ${code}`));
      }
    });

    wgetProcess.on("error", (error) => {
      reject(error);
    });

    setTimeout(() => {
      if (!downloadStarted) {
        wgetProcess.kill();
        reject(new Error("wget timeout - no download started"));
      }
    }, 120000);
  });
}

// Network interception for download URL
async function interceptDownloadUrl(page, fileNumber) {
  return new Promise((resolve, reject) => {
    let downloadUrlCaptured = false;
    const timeout = setTimeout(() => {
      if (!downloadUrlCaptured) {
        reject(new Error("Download URL capture timeout"));
      }
    }, config.delays.downloadTimeout);

    const responseHandler = async (response) => {
      const url = response.url();
      const status = response.status();

      // Skip unwanted URLs
      if (
        url.includes(".js") ||
        url.includes(".css") ||
        url.includes("analytics")
      ) {
        return;
      }

      // Check for 409 Conflict
      if (status === 409) {
        downloadUrlCaptured = true;
        clearTimeout(timeout);
        page.off("response", responseHandler);
        reject(new Error("409_CONFLICT"));
        return;
      }

      // Check for download API response
      if (status === 200 && url.includes("generate_download_url")) {
        try {
          const responseText = await response.text();
          const responseData = JSON.parse(responseText);

          if (responseData && responseData.download_url) {
            downloadUrlCaptured = true;
            clearTimeout(timeout);
            page.off("response", responseHandler);

            const filename = `file_${fileNumber}.zip`;
            resolve({ downloadUrl: responseData.download_url, filename });
          }
        } catch (error) {
          await Logger.debug(
            `Error parsing download response: ${error.message}`
          );
        }
      }
    };

    page.on("response", responseHandler);
  });
}

// Handle popups
async function handlePopups(page) {
  try {
    // Look for close buttons
    const closeButtons = await page.$$(SELECTORS.POPUP_CLOSE);
    for (const button of closeButtons) {
      await button.click();
      await Logger.log("Closed popup");
      await page.waitForTimeout(1000);
    }
  } catch (error) {
    await Logger.debug(`Popup handling: ${error.message}`);
  }
}

// Process individual file
async function processFile(page, row, fileNumber) {
  await Logger.log(`Processing file #${fileNumber}`);
  stats.totalProcessed++;

  try {
    // Save progress
    await saveResumePoint(fileNumber);

    // Extract folder href
    let folderHref = "UNKNOWN";
    try {
      const linkElement = await row.$("a");
      if (linkElement) {
        folderHref = await linkElement.evaluate((el) => el.href);
      }
    } catch (e) {
      await Logger.debug(`Could not extract folder href: ${e.message}`);
    }

    // Hover to reveal download button
    await row.hover();
    await page.waitForTimeout(800);

    // Find and click download button
    const downloadButton = await row.$(SELECTORS.HOVER_DOWNLOAD_BUTTON);
    if (!downloadButton) {
      throw new Error("Download button not found");
    }

    // Set up download interception
    const downloadPromise = interceptDownloadUrl(page, fileNumber);

    // Click download button
    await downloadButton.click();
    await page.waitForTimeout(1000);

    // Handle popup and find continue button
    await page.waitForSelector(SELECTORS.CONTINUE_BUTTON, { timeout: 10000 });

    // Find the specific continue button
    const continueButton = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll(
        'button[data-dig-button="true"]'
      );
      for (const button of buttons) {
        if (button.textContent.includes("continue with download only")) {
          return button;
        }
      }
      return null;
    });

    if (!continueButton) {
      throw new Error("Continue button not found");
    }

    await continueButton.click();

    // Wait for download URL
    const { downloadUrl, filename } = await downloadPromise;

    // Download with wget
    const result = await downloadWithWget(downloadUrl, filename, fileNumber);

    if (result.success) {
      stats.successfulDownloads++;
      await Logger.success(
        `Downloaded file #${fileNumber} as ${result.filename}`
      );

      // Send notification every 10 files
      if (fileNumber % 10 === 0) {
        await sendTelegramMessage(
          `📊 Progress Update\n` +
            `✅ Processed: ${stats.totalProcessed}\n` +
            `📥 Downloaded: ${stats.successfulDownloads}\n` +
            `❌ Failed: ${stats.failedDownloads}`
        );
      }
    }

    return { success: true, filename: result.filename };
  } catch (error) {
    await Logger.error(
      `Error processing file #${fileNumber}: ${error.message}`
    );
    stats.failedDownloads++;

    // Save to MongoDB
    await saveFailedDownload(folderHref, fileNumber, error.message, folderHref);

    if (error.message.includes("409")) {
      stats.conflictErrors++;
      await sendTelegramMessage(
        `🚨 409 Conflict detected for file #${fileNumber}`
      );
    }

    return { success: false, error: error.message };
  }
}

// Progressive scroll
async function progressiveScroll(page, targetRow = null) {
  await Logger.log("Starting progressive scroll");

  if (!targetRow) return;

  const scrollSteps = Math.ceil(targetRow / 10);

  for (let step = 1; step <= scrollSteps; step++) {
    await page.evaluate((scrollAmount) => {
      window.scrollBy(0, window.innerHeight * scrollAmount);
    }, 10);

    await page.waitForTimeout(config.delays.scrollStep);

    if (step % 3 === 0) {
      await Logger.debug(`Scroll progress: ${step}/${scrollSteps}`);
    }
  }

  await page.waitForTimeout(config.delays.verification);
}

// Main browser session
async function runBrowserSession(startFrom = 1) {
  let browser = null;
  let page = null;

  try {
    await Logger.log(`Starting browser session from file #${startFrom}`);

    browser = await puppeteer.launch({
      headless: config.browser.headless ? "new" : false,
      executablePath: "/usr/bin/chromium-browser",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        `--user-data-dir=${config.browser.userDataDir}`,
      ],
    });

    page = await browser.newPage();
    global.currentPage = page; // For screenshot command

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    // Navigate to Dropbox
    await Logger.log("Navigating to Dropbox share URL");
    await page.goto(config.dropbox.shareUrl, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    // Handle cookie consent
    try {
      const cookieButton = await page.$(SELECTORS.COOKIE_CONSENT);
      if (cookieButton) {
        await cookieButton.click();
        await page.waitForTimeout(2000);
        await Logger.log("Cookie consent accepted");
      }
    } catch (e) {
      await Logger.debug("No cookie consent found");
    }

    // Wait for DOM
    await page.waitForTimeout(config.delays.domWait);

    // Progressive scroll if resuming
    if (startFrom > 1) {
      await progressiveScroll(page, startFrom);
    }

    // Get file rows
    const rowGroups = await page.$$(SELECTORS.FILE_ROW_CONTAINER);
    if (rowGroups.length < 2) {
      throw new Error("Could not find file container");
    }

    const fileContainer = rowGroups[1];
    const allRows = await fileContainer.$$(SELECTORS.FILE_ROW);
    await Logger.log(`Found ${allRows.length} files to process`);

    let processedInSession = 0;
    const maxFiles = Math.min(
      allRows.length,
      config.limits.maxFoldersPerSession
    );

    // Process files
    for (
      let i = startFrom - 1;
      i < maxFiles && processedInSession < config.limits.maxFoldersPerSession;
      i++
    ) {
      try {
        // Check for popups periodically
        if (i % 5 === 0) {
          await handlePopups(page);
        }

        const row = allRows[i];
        if (!row) continue;

        await processFile(page, row, i + 1);
        processedInSession++;

        // Small delay between files
        await page.waitForTimeout(2000);
      } catch (error) {
        await Logger.error(`Critical error at file ${i + 1}: ${error.message}`);

        // If unexpected popup, save state and exit
        if (
          error.message.includes("unexpected") ||
          error.message.includes("popup")
        ) {
          await sendTelegramMessage(
            `⚠️ Unexpected popup detected. Saving state at file #${i + 1}`
          );
          await saveResumePoint(i + 1);
          throw error;
        }
      }
    }

    await Logger.success(
      `Session completed. Processed ${processedInSession} files`
    );
    return startFrom + processedInSession;
  } finally {
    if (page) {
      global.currentPage = null;
    }
    if (browser) {
      await browser.close();
      await Logger.log("Browser closed");
    }
  }
}

// Main function
async function main() {
  try {
    // Create directories
    await fs.mkdir(config.paths.download, { recursive: true });
    await fs.mkdir(config.paths.screenshots, { recursive: true });

    // Connect to MongoDB
    await connectMongoDB();

    // Send startup notification
    await sendTelegramMessage("🚀 Dropbox Downloader started");

    // Load resume point
    let currentFile = await loadResumePoint();

    // Run browser session
    const nextFile = await runBrowserSession(currentFile);

    // Send completion stats
    const finalStats =
      `✅ Session completed\n\n` +
      `📊 Final Statistics:\n` +
      `Total Processed: ${stats.totalProcessed}\n` +
      `Successful: ${stats.successfulDownloads}\n` +
      `Failed: ${stats.failedDownloads}\n` +
      `409 Conflicts: ${stats.conflictErrors}\n` +
      `Runtime: ${Math.round((Date.now() - stats.startTime) / 60000)} minutes`;

    await sendTelegramMessage(finalStats);

    // Close MongoDB connection
    if (mongoClient) {
      await mongoClient.close();
    }

    // Exit for PM2 restart
    process.exit(0);
  } catch (error) {
    await Logger.error(`Fatal error: ${error.message}`);
    await sendTelegramMessage(`💥 Fatal error: ${error.message}`);

    if (mongoClient) {
      await mongoClient.close();
    }

    process.exit(1);
  }
}

// Error handlers
process.on("unhandledRejection", async (reason) => {
  await Logger.error(`Unhandled rejection: ${reason}`);
  await sendTelegramMessage(`💥 Unhandled rejection: ${reason}`);
});

process.on("SIGINT", async () => {
  await Logger.log("Graceful shutdown initiated");
  await sendTelegramMessage("⚠️ Script interrupted by user");

  if (mongoClient) {
    await mongoClient.close();
  }

  process.exit(0);
});

// Start the application
main().catch(console.error);
