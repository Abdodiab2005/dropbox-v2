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
    maxFoldersPerSession: Number.parseInt(
      process.env.MAX_FOLDERS_PER_SESSION || 50
    ),
    batchSize: Number.parseInt(process.env.BATCH_SIZE || 75),
  },
  delays: {
    domWait: Number.parseInt(process.env.DOM_WAIT_DELAY || 6000),
    preScroll: Number.parseInt(process.env.PRE_SCROLL_DELAY || 12000),
    scrollStep: Number.parseInt(process.env.SCROLL_STEP_DELAY || 3000),
    verification: Number.parseInt(process.env.VERIFICATION_DELAY || 3000),
    downloadTimeout: Number.parseInt(process.env.DOWNLOAD_TIMEOUT || 30000),
  },
  browser: {
    headless: "new",
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

const PROGRESSIVE_SCROLL_CONFIG = {
  DOM_WAIT_DELAY: 6000,
  PRE_SCROLL_DELAY: 12000,
  SCROLL_BATCH_SIZE: 5, // Reduced from 10 to be more conservative
  SCROLL_STEP_DELAY: 4000, // Increased delay
  VERIFICATION_DELAY: 3000,
  MAX_SCROLL_ATTEMPTS: 20, // Added max attempts to prevent infinite scrolling
  ELEMENT_LOAD_TIMEOUT: 10000, // Added timeout for element loading
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

class Logger {
  static async log(message, type = "INFO") {
    const timestamp = new Date().toISOString();
    const colorMap = {
      INFO: "\x1b[36m",
      SUCCESS: "\x1b[32m",
      ERROR: "\x1b[31m",
      WARNING: "\x1b[33m",
      DEBUG: "\x1b[35m",
      TRACE: "\x1b[90m", // Added trace level
    };
    const color = colorMap[type] || "\x1b[0m";
    console.log(`${timestamp} ${color}[${type}]\x1b[0m ${message}`);
  }

  static async info(message) {
    await this.log(message, "INFO");
  }
  static async success(message) {
    await this.log(message, "SUCCESS");
  }
  static async error(message) {
    await this.log(message, "ERROR");
  }
  static async warning(message) {
    await this.log(message, "WARNING");
  }
  static async debug(message) {
    await this.log(message, "DEBUG");
  }
  static async trace(message) {
    await this.log(message, "TRACE");
  }
}

async function performProgressiveScroll(page) {
  console.log(
    "[v0] Starting enhanced progressive scroll with comprehensive debugging"
  );
  await Logger.info("Starting progressive scroll to load all elements");

  let previousElementCount = 0;
  let stableCount = 0;
  let scrollAttempts = 0;
  const maxStableChecks = 3;

  try {
    // Wait for initial DOM load
    console.log("[v0] Waiting for initial DOM load...");
    await Logger.debug("Waiting for initial DOM load...");
    await page.waitForTimeout(PROGRESSIVE_SCROLL_CONFIG.DOM_WAIT_DELAY);

    // Pre-scroll delay
    console.log("[v0] Pre-scroll delay...");
    await Logger.debug("Pre-scroll delay...");
    await page.waitForTimeout(PROGRESSIVE_SCROLL_CONFIG.PRE_SCROLL_DELAY);

    while (scrollAttempts < PROGRESSIVE_SCROLL_CONFIG.MAX_SCROLL_ATTEMPTS) {
      scrollAttempts++;
      console.log(
        `[v0] Scroll attempt ${scrollAttempts}/${PROGRESSIVE_SCROLL_CONFIG.MAX_SCROLL_ATTEMPTS}`
      );

      let currentElementCount = 0;
      try {
        console.log(
          "[v0] Attempting to count elements with primary selector..."
        );

        // Wait for elements to be present with timeout
        await page.waitForSelector(SELECTORS.FILE_ROW, {
          timeout: PROGRESSIVE_SCROLL_CONFIG.ELEMENT_LOAD_TIMEOUT,
        });

        const elements = await page.$$(SELECTORS.FILE_ROW);
        currentElementCount = elements ? elements.length : 0;
        console.log(
          `[v0] Primary selector found ${currentElementCount} elements`
        );

        if (currentElementCount === 0) {
          console.log(
            "[v0] Primary selector returned 0, trying container-based approach..."
          );
          const containerElements = await page.$$(SELECTORS.FILE_ROW_CONTAINER);
          console.log(`[v0] Found ${containerElements.length} containers`);

          if (containerElements.length >= 2) {
            const fileContainer = containerElements[1];
            if (fileContainer) {
              const rowsInContainer = await fileContainer.$$(
                SELECTORS.FILE_ROW
              );
              currentElementCount = rowsInContainer
                ? rowsInContainer.length
                : 0;
              console.log(
                `[v0] Container-based count: ${currentElementCount} elements`
              );
            } else {
              console.log("[v0] File container is null/undefined");
            }
          }
        }

        await Logger.debug(
          `Scroll attempt ${scrollAttempts}: Found ${currentElementCount} elements (previous: ${previousElementCount})`
        );
      } catch (error) {
        console.log(`[v0] Error counting elements: ${error.message}`);
        await Logger.warning(
          `Error counting elements on attempt ${scrollAttempts}: ${error.message}`
        );

        try {
          console.log("[v0] Trying fallback selectors...");
          let fallbackElements = await page.$$('div[role="row"]');
          if (!fallbackElements || fallbackElements.length === 0) {
            fallbackElements = await page.$$('[data-testid*="ROW"]');
          }
          if (!fallbackElements || fallbackElements.length === 0) {
            fallbackElements = await page.$$('div[role="gridcell"]');
          }

          currentElementCount = fallbackElements ? fallbackElements.length : 0;
          console.log(
            `[v0] Fallback selectors found ${currentElementCount} elements`
          );
          await Logger.debug(`Fallback count: ${currentElementCount} elements`);
        } catch (fallbackError) {
          console.log(
            `[v0] All fallback selectors failed: ${fallbackError.message}`
          );
          await Logger.error(
            `Fallback element counting failed: ${fallbackError.message}`
          );
          currentElementCount = previousElementCount; // Keep previous count to avoid infinite loop
        }
      }

      // Check if we've loaded new elements
      if (currentElementCount > previousElementCount) {
        console.log(
          `[v0] SUCCESS: Loaded ${
            currentElementCount - previousElementCount
          } new elements`
        );
        await Logger.success(
          `Loaded ${currentElementCount - previousElementCount} new elements`
        );
        previousElementCount = currentElementCount;
        stableCount = 0; // Reset stable counter
      } else {
        stableCount++;
        console.log(
          `[v0] No new elements loaded. Stable count: ${stableCount}/${maxStableChecks}`
        );
        await Logger.debug(
          `No new elements loaded. Stable count: ${stableCount}/${maxStableChecks}`
        );

        if (stableCount >= maxStableChecks) {
          console.log(
            `[v0] Element count stable at ${currentElementCount}, stopping scroll`
          );
          await Logger.info(
            `Element count stable at ${currentElementCount} for ${maxStableChecks} attempts. Stopping scroll.`
          );
          break;
        }
      }

      try {
        console.log("[v0] Performing scroll actions...");
        await Logger.trace("Performing scroll action...");

        // Scroll to bottom of page
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });

        // Wait for scroll to complete
        await page.waitForTimeout(PROGRESSIVE_SCROLL_CONFIG.SCROLL_STEP_DELAY);

        if (currentElementCount <= 16 && scrollAttempts > 3) {
          console.log(
            "[v0] Using enhanced scroll techniques for stubborn content..."
          );
          await Logger.debug(
            "Trying alternative scroll methods for stubborn content..."
          );

          // Try scrolling the specific container
          await page.evaluate((selector) => {
            const containers = document.querySelectorAll(selector);
            console.log(
              `[Browser] Found ${containers.length} containers to scroll`
            );
            containers.forEach((container, index) => {
              if (container && container.scrollTop !== undefined) {
                console.log(`[Browser] Scrolling container ${index}`);
                container.scrollTop = container.scrollHeight;
              }
            });
          }, SELECTORS.FILE_ROW_CONTAINER);

          await page.waitForTimeout(2000);

          // Try keyboard scrolling
          await page.keyboard.press("End");
          await page.waitForTimeout(1000);

          await page.keyboard.press("PageDown");
          await page.waitForTimeout(1000);
        }
      } catch (scrollError) {
        console.log(`[v0] Scroll action failed: ${scrollError.message}`);
        await Logger.error(
          `Scroll action failed on attempt ${scrollAttempts}: ${scrollError.message}`
        );
        // Continue to next attempt
      }

      // Verification delay
      await page.waitForTimeout(PROGRESSIVE_SCROLL_CONFIG.VERIFICATION_DELAY);
    }

    console.log(
      `[v0] Progressive scroll completed with ${previousElementCount} total elements`
    );
    await Logger.success(
      `Progressive scroll completed. Final element count: ${previousElementCount}`
    );
    return previousElementCount;
  } catch (error) {
    console.log(`[v0] Progressive scroll failed: ${error.message}`);
    console.log(`[v0] Stack trace: ${error.stack}`);
    await Logger.error(`Progressive scroll failed: ${error.message}`);
    await Logger.error(`Stack trace: ${error.stack}`);
    throw error;
  }
}

async function processFileElements(page, startIndex = 0) {
  console.log(
    `[v0] Starting to process file elements from index ${startIndex}`
  );
  await Logger.info(
    `Starting to process file elements from index ${startIndex}`
  );

  try {
    let fileElements = [];
    try {
      console.log("[v0] Waiting for file elements...");
      await page.waitForSelector(SELECTORS.FILE_ROW, { timeout: 10000 });

      fileElements = await page.$$(SELECTORS.FILE_ROW);
      console.log(
        `[v0] Primary selector found ${
          fileElements ? fileElements.length : 0
        } elements`
      );

      if (!fileElements) {
        console.log("[v0] fileElements is null, initializing as empty array");
        fileElements = [];
      }

      await Logger.debug(`Found ${fileElements.length} file elements total`);
    } catch (error) {
      console.log(`[v0] Failed to find file elements: ${error.message}`);
      await Logger.error(`Failed to find file elements: ${error.message}`);

      try {
        console.log("[v0] Trying fallback selectors...");
        fileElements = await page.$$('div[role="row"]');
        if (!fileElements || fileElements.length === 0) {
          fileElements = await page.$$('[data-testid*="ROW"]');
        }
        if (!fileElements || fileElements.length === 0) {
          fileElements = await page.$$('div[role="gridcell"]');
        }

        if (!fileElements) {
          fileElements = [];
        }

        console.log(`[v0] Fallback found ${fileElements.length} row elements`);
        await Logger.debug(
          `Fallback found ${fileElements.length} row elements`
        );
      } catch (fallbackError) {
        console.log(
          `[v0] Fallback element selection failed: ${fallbackError.message}`
        );
        await Logger.error(
          `Fallback element selection failed: ${fallbackError.message}`
        );
        throw new Error("No file elements found with any selector");
      }
    }

    if (!fileElements || fileElements.length === 0) {
      console.log("[v0] No file elements found on page");
      throw new Error("No file elements found on page");
    }

    const elementsToProcess = fileElements.slice(startIndex);
    console.log(
      `[v0] Processing ${elementsToProcess.length} elements (skipping first ${startIndex})`
    );
    await Logger.info(
      `Processing ${elementsToProcess.length} elements (skipping first ${startIndex})`
    );

    for (let i = 0; i < elementsToProcess.length; i++) {
      const globalIndex = startIndex + i;
      const element = elementsToProcess[i];

      try {
        console.log(
          `[v0] Processing element ${globalIndex + 1}/${fileElements.length}`
        );
        await Logger.debug(
          `Processing element ${globalIndex + 1}/${fileElements.length}`
        );

        if (!element) {
          console.log(
            `[v0] Element at index ${globalIndex} is null/undefined, skipping`
          );
          await Logger.warning(
            `Element at index ${globalIndex} is null/undefined, skipping`
          );
          continue;
        }

        // Check if element is still attached to DOM
        const isAttached = await page.evaluate((el) => {
          return el && el.isConnected && typeof el.isConnected === "boolean";
        }, element);

        if (!isAttached) {
          console.log(
            `[v0] Element at index ${globalIndex} is not attached to DOM, skipping`
          );
          await Logger.warning(
            `Element at index ${globalIndex} is not attached to DOM, skipping`
          );
          continue;
        }

        // Process the file element
        await processFileElement(page, element, globalIndex + 1);

        await saveResumePoint(globalIndex + 1);
      } catch (elementError) {
        console.log(
          `[v0] Failed to process element ${globalIndex + 1}: ${
            elementError.message
          }`
        );
        await Logger.error(
          `Failed to process element ${globalIndex + 1}: ${
            elementError.message
          }`
        );
        stats.failedDownloads++;

        // Save failed download info
        try {
          await saveFailedDownload(
            config.dropbox.shareUrl,
            globalIndex + 1,
            `ELEMENT_PROCESSING_ERROR: ${elementError.message}`,
            config.dropbox.shareUrl
          );
        } catch (saveError) {
          console.log(`[v0] Failed to save error info: ${saveError.message}`);
          await Logger.error(`Failed to save error info: ${saveError.message}`);
        }

        // Continue with next element
        continue;
      }
    }

    console.log(
      `[v0] Completed processing ${elementsToProcess.length} elements`
    );
    await Logger.success(
      `Completed processing ${elementsToProcess.length} elements`
    );
  } catch (error) {
    console.log(`[v0] File element processing failed: ${error.message}`);
    console.log(`[v0] Stack trace: ${error.stack}`);
    await Logger.error(`File element processing failed: ${error.message}`);
    await Logger.error(`Stack trace: ${error.stack}`);
    throw error;
  }
}

async function processFileElement(page, element, fileNumber) {
  try {
    await Logger.trace(`Starting to process file element #${fileNumber}`);

    try {
      // Scroll element into view
      await page.evaluate((el) => {
        if (el && el.scrollIntoView) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, element);

      await page.waitForTimeout(1000);

      const boundingBox = await element.boundingBox();
      if (!boundingBox) {
        throw new Error(
          `Element #${fileNumber} has no bounding box - may be hidden or removed`
        );
      }

      await Logger.trace(
        `Hovering over element #${fileNumber} at position (${boundingBox.x}, ${boundingBox.y})`
      );
      await element.hover();
      await page.waitForTimeout(2000);

      let downloadButton = null;
      let attempts = 0;
      const maxAttempts = 3;

      while (!downloadButton && attempts < maxAttempts) {
        attempts++;
        await Logger.trace(
          `Looking for download button, attempt ${attempts}/${maxAttempts}`
        );

        try {
          downloadButton = await element.$(SELECTORS.HOVER_DOWNLOAD_BUTTON);
          if (!downloadButton) {
            // Try alternative selectors
            downloadButton = await element.$('button[aria-label*="Download"]');
          }
          if (!downloadButton) {
            downloadButton = await element.$('button[title*="Download"]');
          }
        } catch (selectorError) {
          await Logger.debug(
            `Download button selector attempt ${attempts} failed: ${selectorError.message}`
          );
        }

        if (!downloadButton && attempts < maxAttempts) {
          await Logger.debug(
            `Download button not found, re-hovering and waiting...`
          );
          await element.hover();
          await page.waitForTimeout(1500);
        }
      }

      if (!downloadButton) {
        throw new Error(
          `Download button not found for file #${fileNumber} after ${maxAttempts} attempts`
        );
      }

      await Logger.debug(`Found download button for file #${fileNumber}`);

      // Set up network interception before clicking
      const downloadPromise = interceptDownloadUrl(
        page,
        fileNumber,
        config.dropbox.shareUrl
      );

      // Click download button
      await Logger.trace(`Clicking download button for file #${fileNumber}`);
      await downloadButton.click();

      // Wait for download URL
      const downloadInfo = await downloadPromise;
      await Logger.success(
        `Got download URL for file #${fileNumber}: ${downloadInfo.filename}`
      );

      // Download the file
      await downloadFile(
        downloadInfo.downloadUrl,
        downloadInfo.filename,
        fileNumber
      );
      stats.successfulDownloads++;
    } catch (interactionError) {
      await Logger.error(
        `Element interaction failed for file #${fileNumber}: ${interactionError.message}`
      );
      throw interactionError;
    }
  } catch (error) {
    await Logger.error(
      `Processing file element #${fileNumber} failed: ${error.message}`
    );
    throw error;
  }
}

async function downloadFile(url, filename, fileNumber) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(config.paths.download, filename);

    Logger.debug(`Starting download #${fileNumber}: ${filename}`);

    const wgetArgs = [
      "--no-check-certificate",
      "--timeout=30",
      "--tries=3",
      "--continue",
      "--progress=bar:force",
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
      Logger.trace(`wget stdout: ${output.trim()}`);
    });

    wgetProcess.stderr.on("data", (data) => {
      const output = data.toString();
      errorOutput += output;
      if (output.includes("%") || output.includes("saved")) {
        downloadStarted = true;
      }
      Logger.trace(`wget stderr: ${output.trim()}`);
    });

    wgetProcess.on("close", async (code) => {
      if (code === 0) {
        await Logger.success(`Download completed: ${filename}`);
        resolve();
      } else {
        await Logger.error(`wget failed with code ${code} for ${filename}`);
        await Logger.error(`wget error output: ${errorOutput}`);
        reject(new Error(`wget failed with code ${code}: ${errorOutput}`));
      }
    });

    wgetProcess.on("error", async (error) => {
      await Logger.error(`wget process error: ${error.message}`);
      reject(error);
    });

    setTimeout(() => {
      if (!downloadStarted) {
        Logger.error(`Download timeout for ${filename} - killing wget process`);
        wgetProcess.kill();
        reject(new Error("wget timeout - no download started"));
      }
    }, 120000);
  });
}

async function interceptDownloadUrl(page, fileNumber, folderUrl) {
  console.log(`[v0] Setting up network interception for file #${fileNumber}`);

  return new Promise((resolve, reject) => {
    let downloadUrlCaptured = false;
    let conflict409Detected = false;

    const timeout = setTimeout(() => {
      if (!downloadUrlCaptured && !conflict409Detected) {
        console.log(
          `[v0] Download URL capture timeout for file #${fileNumber}`
        );
        Logger.error(`Download URL capture timeout for file #${fileNumber}`);
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
        url.includes("analytics") ||
        url.includes("favicon")
      ) {
        return;
      }

      console.log(
        `[v0] Network response: ${status} ${url.substring(0, 100)}...`
      );
      await Logger.trace(`Network response: ${status} ${url}`);

      if (status === 409) {
        console.log(`[v0] 🚨 409 CONFLICT DETECTED for file #${fileNumber}`);
        console.log(`[v0] Conflict URL: ${url}`);
        console.log(
          `[v0] Response headers: ${JSON.stringify(response.headers())}`
        );

        await Logger.error(`🚨 409 CONFLICT detected for file #${fileNumber}`);
        await Logger.error(`Conflict URL: ${url}`);
        await Logger.error(
          `Response headers: ${JSON.stringify(response.headers())}`
        );

        try {
          const responseText = await response.text();
          console.log(
            `[v0] 409 Response body: ${responseText.substring(0, 200)}...`
          );
          await Logger.error(
            `409 Response body: ${responseText.substring(0, 200)}...`
          );
        } catch (bodyError) {
          console.log(
            `[v0] Could not read 409 response body: ${bodyError.message}`
          );
        }

        conflict409Detected = true;
        downloadUrlCaptured = true;
        clearTimeout(timeout);
        page.off("response", responseHandler);

        // Save to MongoDB immediately with enhanced info
        await saveFailedDownload(
          folderUrl || url,
          fileNumber,
          `409_CONFLICT - URL: ${url}`,
          folderUrl
        );
        stats.conflictErrors++;

        reject(new Error("409_CONFLICT"));
        return;
      }

      if (status === 200 && !downloadUrlCaptured) {
        const isDownloadUrl =
          url.includes("generate_download_url") ||
          url.includes("download") ||
          url.includes("content_link") ||
          url.includes("dl=1") ||
          url.includes("raw=1") ||
          url.includes("export") ||
          (url.includes("dropbox") &&
            (url.includes("dl=") || url.includes("raw=")));

        if (isDownloadUrl) {
          console.log(
            `[v0] Potential download URL detected: ${url.substring(0, 100)}...`
          );

          try {
            const responseText = await response.text();
            console.log(
              `[v0] Download API response length: ${responseText.length}`
            );
            await Logger.trace(
              `Download API response: ${responseText.substring(0, 200)}...`
            );

            let downloadUrl = null;
            let filename = `file_${fileNumber}.zip`;

            // Try to parse as JSON first
            try {
              const responseData = JSON.parse(responseText);
              console.log(
                `[v0] Parsed JSON response, keys: ${Object.keys(responseData)}`
              );

              if (responseData && responseData.download_url) {
                downloadUrl = responseData.download_url;
                console.log(`[v0] Found download_url in JSON response`);
              }
            } catch (jsonError) {
              console.log(
                `[v0] Response is not JSON, checking if URL is direct download`
              );
              // If not JSON, check if the URL itself is a direct download link
              if (url.includes("dl=1") || url.includes("raw=1")) {
                downloadUrl = url;
                console.log(`[v0] Using response URL as direct download link`);
              }
            }

            if (downloadUrl) {
              console.log(
                `[v0] SUCCESS: Captured download URL for file #${fileNumber}`
              );
              downloadUrlCaptured = true;
              clearTimeout(timeout);
              page.off("response", responseHandler);

              // Extract filename from URL
              const urlParts = downloadUrl.split("/");
              const lastPart = urlParts[urlParts.length - 1];
              if (lastPart && lastPart.includes(".")) {
                filename = lastPart.split("?")[0];
              }

              await Logger.success(
                `Captured download URL for file #${fileNumber}: ${filename}`
              );
              resolve({ downloadUrl, filename });
            } else {
              console.log(`[v0] No download URL found in response`);
            }
          } catch (error) {
            console.log(
              `[v0] Error parsing download response: ${error.message}`
            );
            await Logger.debug(
              `Error parsing download response for file #${fileNumber}: ${error.message}`
            );
          }
        }
      }
    };

    page.on("response", responseHandler);
  });
}

async function handlePopups(page) {
  try {
    await Logger.trace("Checking for popups to close...");

    // Look for close buttons with multiple selectors
    const closeSelectors = [
      SELECTORS.POPUP_CLOSE,
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      '[data-testid="close-button"]',
      ".close-button",
      '[role="button"][aria-label*="close" i]',
    ];

    for (const selector of closeSelectors) {
      try {
        const closeButtons = await page.$$(selector);
        for (const button of closeButtons) {
          const isVisible = await page.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }, button);

          if (isVisible) {
            await button.click();
            await Logger.debug(`Closed popup using selector: ${selector}`);
            await page.waitForTimeout(1000);
          }
        }
      } catch (selectorError) {
        // Continue to next selector
      }
    }

    // Handle cookie consent
    try {
      const cookieButton = await page.$(SELECTORS.COOKIE_CONSENT);
      if (cookieButton) {
        await cookieButton.click();
        await Logger.debug("Accepted cookie consent");
        await page.waitForTimeout(1000);
      }
    } catch (cookieError) {
      // Cookie consent not found, continue
    }
  } catch (error) {
    await Logger.warning(`Popup handling failed: ${error.message}`);
  }
}

// MongoDB connection
async function connectMongoDB() {
  try {
    await Logger.info("Connecting to MongoDB...");
    mongoClient = new MongoClient(config.mongodb.uri);
    await mongoClient.connect();
    db = mongoClient.db(config.mongodb.dbName);
    await Logger.success("Connected to MongoDB");
  } catch (error) {
    await Logger.error(`MongoDB connection failed: ${error.message}`);
    throw error;
  }
}

// Save failed download
async function saveFailedDownload(url, fileNumber, error, folderUrl) {
  try {
    if (!db) {
      await Logger.warning(
        "MongoDB not connected, cannot save failed download"
      );
      return;
    }

    const failedDownload = {
      url,
      fileNumber,
      error,
      folderUrl,
      timestamp: new Date(),
      sessionId: stats.startTime,
    };

    await db
      .collection(config.mongodb.failedCollection)
      .insertOne(failedDownload);
    await Logger.debug(`Saved failed download info for file #${fileNumber}`);
  } catch (error) {
    await Logger.error(`Failed to save error info: ${error.message}`);
  }
}

// Telegram notification
async function sendTelegramMessage(message) {
  try {
    if (config.telegram.token && config.telegram.chatId) {
      await bot.sendMessage(config.telegram.chatId, message);
    }
  } catch (error) {
    await Logger.warning(`Telegram notification failed: ${error.message}`);
  }
}

// Resume point management
async function loadResumePoint() {
  try {
    const resumeFile = path.join(__dirname, "resume_point.txt");
    if (fsSync.existsSync(resumeFile)) {
      const resumePoint = Number.parseInt(
        await fs.readFile(resumeFile, "utf8")
      );
      await Logger.info(`Resuming from file #${resumePoint}`);
      return resumePoint;
    }
  } catch (error) {
    await Logger.warning(`Failed to load resume point: ${error.message}`);
  }
  return 0;
}

async function saveResumePoint(fileNumber) {
  try {
    const resumeFile = path.join(__dirname, "resume_point.txt");
    await fs.writeFile(resumeFile, fileNumber.toString());
  } catch (error) {
    await Logger.warning(`Failed to save resume point: ${error.message}`);
  }
}

async function runBrowserSession(startFile = 0) {
  let browser = null;
  let page = null;

  try {
    await Logger.info("Starting browser session...");

    browser = await puppeteer.launch({
      headless: config.browser.headless,
      userDataDir: config.browser.userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });

    page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    // Navigate to Dropbox share URL
    await Logger.info(`Navigating to: ${config.dropbox.shareUrl}`);
    await page.goto(config.dropbox.shareUrl, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Handle initial popups
    await handlePopups(page);
    await page.waitForTimeout(3000);

    // Perform progressive scroll to load all elements
    const totalElements = await performProgressiveScroll(page);
    await Logger.info(
      `Progressive scroll completed. Total elements available: ${totalElements}`
    );

    // Process file elements
    await processFileElements(page, startFile);

    await Logger.success("Browser session completed successfully");
    return totalElements;
  } catch (error) {
    await Logger.error(`Browser session failed: ${error.message}`);
    await Logger.error(`Stack trace: ${error.stack}`);

    // Take screenshot for debugging
    if (page) {
      try {
        const screenshotPath = path.join(
          config.paths.screenshots,
          `error_${Date.now()}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await Logger.info(`Error screenshot saved: ${screenshotPath}`);
      } catch (screenshotError) {
        await Logger.warning(
          `Failed to take error screenshot: ${screenshotError.message}`
        );
      }
    }

    throw error;
  } finally {
    if (page) {
      await page.close();
      await Logger.debug("Page closed");
    }
    if (browser) {
      await browser.close();
      await Logger.debug("Browser closed");
    }
  }
}

async function main() {
  try {
    await Logger.info("🚀 Starting Dropbox Downloader with enhanced debugging");
    await Logger.info(`Configuration: ${JSON.stringify(config, null, 2)}`);

    // Create directories
    await fs.mkdir(config.paths.download, { recursive: true });
    await fs.mkdir(config.paths.screenshots, { recursive: true });
    await Logger.debug("Created necessary directories");

    // Connect to MongoDB
    await connectMongoDB();

    // Send startup notification
    await sendTelegramMessage(
      "🚀 Dropbox Downloader started with enhanced debugging"
    );

    // Load resume point
    const currentFile = await loadResumePoint();
    stats.resumePoint = currentFile;

    // Run browser session
    const nextFile = await runBrowserSession(currentFile);

    // Send completion stats
    const runtime = Math.round((Date.now() - stats.startTime) / 60000);
    const finalStats =
      `✅ Session completed\n\n` +
      `📊 Final Statistics:\n` +
      `Total Processed: ${stats.totalProcessed}\n` +
      `Successful: ${stats.successfulDownloads}\n` +
      `Failed: ${stats.failedDownloads}\n` +
      `409 Conflicts: ${stats.conflictErrors}\n` +
      `Resume Point: ${stats.resumePoint}\n` +
      `Runtime: ${runtime} minutes`;

    await Logger.success(finalStats);
    await sendTelegramMessage(finalStats);

    // Close MongoDB connection
    if (mongoClient) {
      await mongoClient.close();
      await Logger.debug("MongoDB connection closed");
    }

    // Exit for PM2 restart
    process.exit(0);
  } catch (error) {
    await Logger.error(`💥 Fatal error: ${error.message}`);
    await Logger.error(`Stack trace: ${error.stack}`);
    await sendTelegramMessage(`💥 Fatal error: ${error.message}`);

    if (mongoClient) {
      await mongoClient.close();
    }

    process.exit(1);
  }
}

process.on("unhandledRejection", async (reason, promise) => {
  await Logger.error(`Unhandled rejection at: ${promise}`);
  await Logger.error(`Reason: ${reason}`);
  if (reason && reason.stack) {
    await Logger.error(`Stack: ${reason.stack}`);
  }
  await sendTelegramMessage(`💥 Unhandled rejection: ${reason}`);
});

process.on("uncaughtException", async (error) => {
  await Logger.error(`Uncaught exception: ${error.message}`);
  await Logger.error(`Stack: ${error.stack}`);
  await sendTelegramMessage(`💥 Uncaught exception: ${error.message}`);
  process.exit(1);
});

main().catch(async (error) => {
  await Logger.error(`Application startup failed: ${error.message}`);
  process.exit(1);
});
