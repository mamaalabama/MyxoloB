import * as maptilerClient from "@maptiler/client";
import express from "express";
import fs from "fs/promises";
import path from "path";
import playwright from "playwright";
import { config } from "./config.js";
import db, { logGeocodingAttempt, logMapGeneration } from "./database.js"; // for update query

maptilerClient.config.apiKey = config.maptilerKey;

// Use a shared cache for the duration of one generateMap call
const geoCache = new Map();
let currentMessageId = null;

// Helper for cardinal direction offsets (approx. 1.5 degrees)
const cardinalDirections = {
  north: { lat: 1.5, lon: 0 },
  n: { lat: 1.5, lon: 0 },
  south: { lat: -1.5, lon: 0 },
  s: { lat: -1.5, lon: 0 },
  east: { lat: 0, lon: 1.5 },
  e: { lat: 0, lon: 1.5 },
  west: { lat: 0, lon: -1.5 },
  w: { lat: 0, lon: -1.5 },
  "north-east": { lat: 1.06, lon: 1.06 },
  northeast: { lat: 1.06, lon: 1.06 },
  ne: { lat: 1.06, lon: 1.06 },
  "north-west": { lat: 1.06, lon: -1.06 },
  northwest: { lat: 1.06, lon: -1.06 },
  nw: { lat: 1.06, lon: -1.06 },
  "south-east": { lat: -1.06, lon: 1.06 },
  southeast: { lat: -1.06, lon: 1.06 },
  se: { lat: -1.06, lon: 1.06 },
  "south-west": { lat: -1.06, lon: -1.06 },
  southwest: { lat: -1.06, lon: -1.06 },
  sw: { lat: -1.06, lon: -1.06 },
};

async function geocodeLocation(locationName) {
  if (!locationName) return null;
  if (geoCache.has(locationName)) return geoCache.get(locationName);
  let coords = null;
  let success = 0;
  let lat = null,
    lon = null;
  try {
    const result = await maptilerClient.geocoding.forward(locationName, {
      limit: 1,
      language: ["en", "uk", "ru"],
      country: ["ua", "ru"],
    });
    if (result.features.length > 0) {
      [lon, lat] = result.features[0].center;
      coords = { lon, lat };
      success = 1;
      geoCache.set(locationName, coords);
    } else {
      console.warn(`[Geo] ⚠️ Failed to geocode: '${locationName}'`);
    }
  } catch (error) {
    console.error(`[Geo] ❌ Error geocoding '${locationName}':`, error.message);
  }

  if (currentMessageId) {
    logGeocodingAttempt({
      message_id: currentMessageId,
      location_name: locationName,
      latitude: lat,
      longitude: lon,
      success: success,
    });
  }
  return coords;
}

async function createMapHtml(mapData) {
  try {
    const templateContent = await fs.readFile(config.templatePath, "utf-8");
    // Stringify data safely
    const dataString = JSON.stringify(mapData);
    return templateContent.replace("__MAP_DATA__", dataString);
  } catch (error) {
    console.error(
      `[MapGen] Error reading template file ${config.templatePath}:`,
      error
    );
    throw error; // Re-throw to stop map generation
  }
}

// Helper to calculate distance in km (Haversine formula approximation)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Main Export
export async function generateMap(activeObjects, messageId) {
  currentMessageId = messageId; // Set for logging context
  geoCache.clear(); // Clear cache for each new map generation

  if (activeObjects.length === 0) {
    console.log("[MapGen] No active objects. Not generating map.");
    // Optionally generate a default view map if needed
    return null;
  }

  const objectsWithCoords = await Promise.all(
    activeObjects.map(async (obj) => ({
      ...obj,
      fromCoords: await geocodeLocation(obj.from),
      toCoords: await geocodeLocation(obj.to),
    }))
  );

  // --- NEW: DYNAMIC DIRECTION PROCESSING ---
  for (const obj of objectsWithCoords) {
    if (obj.direction && obj.fromCoords) {
      console.log(
        `[MapGen] Processing direction '${obj.direction}' for object from '${obj.from}'`
      );
      const directionNormalized = obj.direction
        .toLowerCase()
        .replace(/[\s,.]/g, "")
        .replace("towards", "");

      if (cardinalDirections[directionNormalized]) {
        const offset = cardinalDirections[directionNormalized];
        obj.toCoords = {
          lon: obj.fromCoords.lon + offset.lon,
          lat: obj.fromCoords.lat + offset.lat,
        };
        console.log(
          `[MapGen] Applied cardinal offset. New toCoords:`,
          obj.toCoords
        );
      } else {
        // Treat direction as a location to geocode
        const targetCoords = await geocodeLocation(obj.direction);
        if (targetCoords) {
          obj.toCoords = targetCoords;
          console.log(`[MapGen] Geocoded direction to coords:`, targetCoords);
        } else {
          console.warn(
            `[MapGen] Could not geocode direction '${obj.direction}', object will be static.`
          );
          obj.toCoords = obj.fromCoords; // Fallback to make it static
        }
      }
    }
  }

  const plottableObjects = objectsWithCoords.filter(
    (o) => o.fromCoords && o.toCoords
  );
  if (plottableObjects.length === 0) {
    console.error(
      "[MapGen] ❌ No plottable objects after geocoding/direction processing. Aborting map."
    );
    if (currentMessageId) {
      logMapGeneration({
        message_id: currentMessageId,
        screenshot_path: "PROCESS_FAIL",
        plottable_objects_json: [],
        view_parameters_json: { error: "No valid coordinates" },
      });
    }
    return null;
  }
  if (plottableObjects.length < activeObjects.length) {
    console.warn(
      `[MapGen] ⚠️ Only ${plottableObjects.length} out of ${activeObjects.length} objects could be plotted.`
    );
  }

  // --- SMART BOUNDING BOX LOGIC ---
  let view = {
    ...config.defaultMapView,
    defaultCenter: config.defaultMapView.center,
    defaultZoom: config.defaultMapView.zoom,
  }; // Start with default
  const corePoints = [];
  const allPoints = [];
  const regionalRegex =
    /oblast|region|western|southern|northern|eastern|west|south|north|east|district/i;

  plottableObjects.forEach((obj) => {
    const isFromRegional = regionalRegex.test(obj.from);
    const isToRegional = regionalRegex.test(obj.to);
    allPoints.push(obj.fromCoords, obj.toCoords);
    if (!isFromRegional) corePoints.push(obj.fromCoords);
    if (!isToRegional && obj.to !== obj.from) corePoints.push(obj.toCoords); // Avoid double-counting static/directional points
  });

  const pointsForBounds = corePoints.length > 1 ? corePoints : allPoints;

  let [minLon, maxLon, minLat, maxLat] = [180, -180, 90, -90];
  pointsForBounds.forEach((p) => {
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  });

  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  const maxDistKm = 800; // Max distance from center to include in bounds
  const filteredPoints = pointsForBounds.filter(
    (p) => calculateDistance(centerLat, centerLon, p.lat, p.lon) < maxDistKm
  );

  if (filteredPoints.length > 0) {
    [minLon, maxLon, minLat, maxLat] = [180, -180, 90, -90]; // Recalculate
    filteredPoints.forEach((p) => {
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
    });
  } else {
    if (pointsForBounds.length > 0) {
      minLon = maxLon = pointsForBounds[0].lon;
      minLat = maxLat = pointsForBounds[0].lat;
    }
  }

  const lonRange = maxLon - minLon;
  const latRange = maxLat - minLat;
  const lonPadding = lonRange < 0.5 ? 1.5 : lonRange * 0.3;
  const latPadding = latRange < 0.5 ? 1.5 : latRange * 0.3;

  view.bounds = {
    west: minLon - lonPadding,
    south: minLat - latPadding,
    east: maxLon + lonPadding,
    north: maxLat + latPadding,
  };
  // --- END SMART BOUNDING ---

  // Pass all required data, including new aesthetic settings, to the template
  const mapData = {
    modelPaths: config.modelInfo,
    objects: plottableObjects,
    view,
    // Pass aesthetic settings from config
    mapPitch: config.mapPitch,
    mapBearing: config.mapBearing,
    modelScaleFactor: config.modelScaleFactor,
    showMapLabels: config.showMapLabels,
  };

  const screenshotPath = path.join(
    config.screenshotsPath,
    `map_${messageId}.png`
  );

  if (currentMessageId) {
    logMapGeneration({
      message_id: currentMessageId,
      screenshot_path: screenshotPath,
      plottable_objects_json: plottableObjects,
      view_parameters_json: view,
    });
  }

  const app = express();
  app.use(express.static(config.publicPath));
  app.get("/", async (req, res) => {
    try {
      res.send(await createMapHtml(mapData));
    } catch (e) {
      res.status(500).send("Template Error");
    }
  });
  const server = app.listen(0);
  const actualPort = server.address().port;
  const pageUrl = `http://localhost:${actualPort}`;

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: {
      width: config.screenshotWidth,
      height: config.screenshotHeight,
    },
  });
  page.on("console", (msg) =>
    console.log(`[Browser] ${msg.type()}: ${msg.text()}`)
  );
  page.on("pageerror", (err) =>
    console.error(`[Browser] Page Error: ${err.message}`)
  );

  try {
    await fs.mkdir(config.screenshotsPath, { recursive: true });
    await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 60000 });
    // FIX: Wait for signal, map load, AND map idle events, accessing map instance from window
    await Promise.all([
      page.waitForSelector("#models-ready", {
        state: "attached",
        timeout: 60000,
      }),
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const map = window.map; // Access map instance from window
            if (map && map.loaded()) resolve();
            else if (map) map.once("load", resolve);
            else setTimeout(resolve, 1000); // Failsafe
          })
      ),
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const map = window.map; // Access map instance from window
            if (map && !map.isMoving()) resolve();
            else if (map) map.once("idle", resolve);
            else setTimeout(resolve, 1000); // Failsafe
          })
      ),
    ]);

    await page.waitForTimeout(3000); // Short final pause
    await page.screenshot({
      path: screenshotPath,
      type: "png",
      omitBackground: false,
    });
    console.log(`[MapGen] ✅ Screenshot saved to ${screenshotPath}`);
    return screenshotPath;
  } catch (e) {
    console.error(
      `[MapGen] ❌ Playwright Error generating map for msg ${messageId}:`,
      e
    );
    try {
      await page.screenshot({ path: "error_screenshot.png" });
    } catch {}
    if (currentMessageId) {
      const updateStmt = db.prepare(
        "UPDATE map_generation_log SET screenshot_path = ? WHERE message_id = ?"
      );
      updateStmt.run(`PLAYWRIGHT_ERROR: ${e.name}`, currentMessageId);
    }
    return null;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    currentMessageId = null;
  }
}
