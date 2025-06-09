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

app.use(express.static(path.join(__dirname, "public")));

app.get("/", async (req, res) => {
  try {
    const htmlPath = path.join(__dirname, "animation-sandbox.html");
    const dataPath = path.join(__dirname, "sample-data.json");

    const htmlTemplate = await fs.readFile(htmlPath, "utf-8");
    const sampleDataString = await fs.readFile(dataPath, "utf-8");
    const sampleData = JSON.parse(sampleDataString);

    const combinedData = { ...sampleData, ...config };

    const finalHtml = htmlTemplate.replace(
      "__MAP_DATA__",
      JSON.stringify(combinedData)
    );
    res.send(finalHtml);
  } catch (error) {
    console.error("Error serving sandbox page:", error);
    res.status(500).send("<h1>Error loading sandbox files</h1>");
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
    const videoPath = path.join(videoDir, `sentry-cinematic-${Date.now()}.mp4`);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    });

    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}`, { waitUntil: "networkidle" });
    console.log("[Recorder] Page loaded. Capturing 20-second animation...");
    await page.waitForTimeout(20000); // Increased to capture full loop + pause

    const tempVideoPath = await page.video().path();
    await context.close();
    await fs.rename(tempVideoPath, videoPath);

    console.log(`[Recorder] ✅🎬 Video saved successfully to: ${videoPath}`);
  } catch (e) {
    console.error("[Recorder] ❌ An error occurred during recording:", e);
  } finally {
    if (browser) await browser.close();
    isRecording = false;
    console.log("[Recorder] Process finished.");
  }
});

app.listen(PORT, () => {
  console.log("--- 🚀 Cinematic Sandbox Server ---");
  console.log(`Open browser to: http://localhost:${PORT}`);
  console.log("The animation will start automatically.");
  console.log("Click the record button on the page to save a video.");
  console.log("------------------------------------");
});
