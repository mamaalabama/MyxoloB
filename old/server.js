// FILE: server.js
import express from "express";
import fs from "fs/promises";
import path from "path";
import playwright from "playwright";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8080;
let isRecording = false;

// Serve static files (like 3D models and assets) from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// API endpoint to list available 3D models
app.get("/api/models", async (req, res) => {
  try {
    const assetsDir = path.join(__dirname, "public", "assets");
    const files = await fs.readdir(assetsDir);
    const gltfFiles = files.filter((file) => file.endsWith(".gltf"));
    res.json(gltfFiles);
  } catch (error) {
    console.error("Error reading models directory:", error);
    res.status(500).json({ error: "Could not list models." });
  }
});

// Main route to serve the sandbox page
app.get("/", async (req, res) => {
  try {
    res.sendFile(path.join(__dirname, "sandbox.html"));
  } catch (error) {
    console.error("Error serving sandbox.html:", error);
    res.status(500).send("<h1>Error loading sandbox.</h1>");
  }
});

// Endpoint to trigger video recording
app.get("/record", async (req, res) => {
  if (isRecording) {
    return res.status(429).json({ message: "Recording already in progress." });
  }
  isRecording = true;
  console.log("[Recorder] ▶️ Starting video recording process...");
  res.json({ message: "Recording started. See server console for progress." });

  const animationDuration = parseInt(req.query.duration, 10) || 20000;
  console.log(`[Recorder] Recording for ${animationDuration / 1000} seconds.`);

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
    await page.goto(`http://localhost:${PORT}?recording=true`, {
      waitUntil: "networkidle",
    });

    await page.waitForFunction(() => window.isAnimationPlaying === true, null, {
      timeout: 60000,
    });
    console.log(
      "[Recorder] Page loaded and animation is playing. Capturing..."
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
  console.log("--- 🚀 Cinematic Sandbox Server ---");
  console.log(`Open your browser to: http://localhost:${PORT}`);
  console.log("------------------------------------");
});
