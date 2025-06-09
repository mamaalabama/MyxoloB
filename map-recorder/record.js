const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpeg = require("ffmpeg-static");

// --- Configuration ---
const HTML_FILE_PATH = path.resolve(__dirname, "animation.html");
const FRAMES_DIR = path.resolve(__dirname, "frames");
const OUTPUT_VIDEO_PATH = path.resolve(__dirname, "cinematic_flight.mp4");
const VIEWPORT_SIZE = { width: 1920, height: 1080 }; // Full HD
const FRAME_RATE = 30;

async function recordVideo() {
  console.log("Starting video recording process...");

  if (fs.existsSync(FRAMES_DIR)) {
    fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  console.log("Frames directory prepared.");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT_SIZE,
  });
  const page = await context.newPage();
  console.log("Headless browser launched.");

  // Log any console errors from the browser page to the Node.js console
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.error(`[Browser Error]: ${msg.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    console.error(`[Page Error]: ${error.message}`);
  });

  let frameCount = 0;
  let capturePromise = null;

  await page.exposeFunction("onFrameReady", () => {
    const framePath = path.join(
      FRAMES_DIR,
      `frame-${String(frameCount++).padStart(5, "0")}.png`
    );
    capturePromise = (capturePromise || Promise.resolve()).then(() =>
      page.screenshot({ path: framePath })
    );
  });

  const mapReadyPromise = new Promise((resolve) => {
    page.exposeFunction("onMapReady", resolve);
  });
  const animationCompletePromise = new Promise((resolve) => {
    page.exposeFunction("onAnimationComplete", resolve);
  });

  console.log(`Navigating to: file://${HTML_FILE_PATH}`);

  try {
    await page.goto(`file://${HTML_FILE_PATH}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
  } catch (e) {
    console.error(
      "Navigation failed. Check the HTML file path and ensure it's correct.",
      e
    );
    await browser.close();
    return;
  }

  console.log(
    "Page navigation complete. Waiting for map and models to be ready..."
  );

  try {
    await mapReadyPromise;
  } catch (e) {
    console.error(
      "Timed out waiting for the map to become ready. This often means the API key is invalid or there was a network error loading resources.",
      e
    );
    await browser.close();
    return;
  }

  console.log("Map and models are ready. Starting animation...");

  await page.evaluate(() => window.startAnimation());

  await animationCompletePromise;
  console.log(`Animation complete. Captured ${frameCount} frames.`);

  await capturePromise;

  await browser.close();
  console.log("Browser closed.");

  await createVideoFromFrames();

  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  console.log("Frames directory cleaned up.");
  console.log(`✅ Video saved successfully to: ${OUTPUT_VIDEO_PATH}`);
}

function createVideoFromFrames() {
  console.log("Starting FFmpeg to compile video...");
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-framerate",
      FRAME_RATE,
      "-i",
      path.join(FRAMES_DIR, "frame-%05d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "18",
      OUTPUT_VIDEO_PATH,
    ];

    const process = spawn(ffmpeg, args);

    process.stderr.on("data", (data) => {
      // Uncomment for verbose FFmpeg output
      // console.log(`ffmpeg: ${data}`);
    });

    process.on("close", (code) => {
      if (code === 0) {
        console.log("FFmpeg process completed successfully.");
        resolve();
      } else {
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });

    process.on("error", (err) => {
      reject(err);
    });
  });
}

recordVideo().catch(console.error);
