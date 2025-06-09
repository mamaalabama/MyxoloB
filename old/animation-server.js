import express from "express";
import fs from "fs/promises";
import path from "path";
import playwright from "playwright";
import { fileURLToPath } from "url";
import { config } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8080;
let isRecording = false;

// Serve static files (like 3D models) from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// Main route to serve the animation page
app.get("/", async (req, res) => {
  try {
    const htmlPath = path.join(__dirname, "animation.html");
    const dataPath = path.join(__dirname, "sample-data.json");

    const htmlTemplate = await fs.readFile(htmlPath, "utf-8");
    const sampleDataString = await fs.readFile(dataPath, "utf-8");
    const sampleData = JSON.parse(sampleDataString);

    // Combine sample data with the aesthetic config settings
    const combinedData = { ...sampleData, ...config };

    // Inject the combined data object into the HTML
    const finalHtml = htmlTemplate.replace(
      "__MAP_DATA__",
      JSON.stringify(combinedData)
    );
    res.send(finalHtml);
  } catch (error) {
    console.error("Error serving animation page:", error);
    res.status(500).send("<h1>Error loading animation files</h1>");
  }
});

app.get("/record", async (req, res) => {
  if (isRecording) {
    return res.status(429).json({ message: "Recording already in progress." });
  }
  isRecording = true;
  console.log("[Recorder] ▶️ Starting video recording process...");
  res.json({ message: "Recording started. See server console for progress." });

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const videoDir = path.join(__dirname, "videos");
    await fs.mkdir(videoDir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    });

    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}`, { waitUntil: "networkidle" });

    // Wait for a signal from the page that the animation is ready
    await page.waitForFunction(() => window.animationReadyForRecording, null, {
      timeout: 60000,
    });
    console.log(
      "[Recorder] Page loaded and animation is running. Capturing one full loop..."
    );

    // The page will set a variable with the total loop duration
    const animationDuration = await page.evaluate(
      () => window.animationLoopDuration
    );
    await page.waitForTimeout(animationDuration);

    const tempVideoPath = await page.video().path();
    const finalVideoPath = path.join(
      videoDir,
      `sentry-cinematic-${Date.now()}.mp4`
    );
    await context.close();
    await fs.rename(tempVideoPath, finalVideoPath);

    console.log(
      `[Recorder] ✅🎬 Video saved successfully to: ${finalVideoPath}`
    );
  } catch (e) {
    console.error("[Recorder] ❌ An error occurred during recording:", e);
  } finally {
    if (browser) await browser.close();
    isRecording = false;
    console.log("[Recorder] Process finished.");
  }
});

app.listen(PORT, () => {
  console.log("--- 🚀 Cinematic Animation Server ---");
  console.log(`Open your browser to: http://localhost:${PORT}`);
  console.log("The animation will start and loop automatically.");
  console.log(
    "Click the record button on the page to save a video of one full loop."
  );
  console.log("---------------------------------------");
});
