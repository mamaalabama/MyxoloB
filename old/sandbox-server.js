import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js"; // Import the main config

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8080;

// Serve static files (like 3D models) from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// Main route to serve the sandbox page
app.get("/", async (req, res) => {
  try {
    const sandboxHtmlPath = path.join(__dirname, "sandbox.html");
    const sampleDataPath = path.join(__dirname, "sample-data.json");

    // Read the HTML template and the sample data
    const htmlTemplate = await fs.readFile(sandboxHtmlPath, "utf-8");
    const sampleDataString = await fs.readFile(sampleDataPath, "utf-8");
    const sampleData = JSON.parse(sampleDataString);

    // Combine sample data with the aesthetic config settings
    const combinedData = {
      ...sampleData,
      mapPitch: config.mapPitch,
      mapBearing: config.mapBearing,
      mapZoom: config.mapZoom,
      modelScaleFactor: config.modelScaleFactor,
      modelAltitude: config.modelAltitude,
      showMapLabels: config.showMapLabels,
    };

    // Inject the combined data object into the HTML
    const finalHtml = htmlTemplate.replace(
      "__MAP_DATA__",
      JSON.stringify(combinedData)
    );

    res.send(finalHtml);
  } catch (error) {
    console.error("Error serving sandbox:", error);
    res
      .status(500)
      .send(
        "<h1>Error loading sandbox.</h1><p>Make sure sandbox.html and sample-data.json exist.</p>"
      );
  }
});

app.listen(PORT, () => {
  console.log("--- 🚀 Sandbox Server is Running ---");
  console.log(`Open your browser and navigate to: http://localhost:${PORT}`);
  console.log("-----------------------------------");
  console.log(
    "The sandbox now starts with your preferred default settings from config.js."
  );
  console.log("Use the on-screen controls to experiment further.");
  console.log("Press Ctrl+C to stop the server.");
});
