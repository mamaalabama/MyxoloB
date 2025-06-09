import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

export const config = {
  // --- Core Credentials ---
  apiId: parseInt(process.env.API_ID),
  apiHash: process.env.API_HASH,
  sessionString: process.env.TELEGRAM_SESSION_STRING,
  sourceChannel: process.env.SOURCE_CHANNEL_USERNAME,
  destinationChannel: process.env.DESTINATION_CHANNEL_USERNAME,

  // --- Services ---
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  maptilerKey: process.env.MAPTILER_KEY,
  llmModel: process.env.LLM_MODEL || "google/gemma-3-4b-it",

  // --- File Paths ---
  dbPath: path.resolve(__dirname, "./history/db/sentry.sqlite"),
  screenshotsPath: path.resolve(__dirname, "./history/screenshots/"),
  templatePath: path.resolve(__dirname, "template.html"),
  publicPath: path.resolve(__dirname, "public"),

  // --- Application Behavior ---
  serverPort: 3000,
  screenshotWidth: 1280,
  screenshotHeight: 720,
  stateResetTimeout: 60 * 60 * 1000, // 1 hour

  // --- Aesthetic & Map Generation Settings ---
  // Your preferred settings are now the default.
  mapPitch: 30, // Your selected map angle
  mapBearing: 0, // Your selected map rotation
  mapZoom: 5, // A good default zoom level
  modelScaleFactor: 8000, // Your 'Model Size: 10'
  modelAltitude: 7500, // Your preferred altitude (5000-10000 range)
  showMapLabels: false, // Your 'Show Place Labels: Unchecked'

  defaultMapView: {
    center: [31.16558, 48.379433], // Center of Ukraine
    zoom: 5,
  },
  modelInfo: {
    shahed: { path: "/assets/shahed.gltf", rotation: 90 },
    rocket: { path: "/assets/rocket.gltf", rotation: 90 },
    default: { path: "/assets/shahed.gltf", rotation: 90 },
  },
};
// Validation (simple check)
Object.keys(config).forEach((key) => {
  if (
    config[key] === undefined ||
    config[key] === null ||
    (typeof config[key] === "number" && isNaN(config[key]))
  ) {
    if (!["sessionString", "apiId", "apiHash"].includes(key)) {
      console.warn(`Config Warning: Value for ${key} is missing or invalid.`);
    }
  }
});
