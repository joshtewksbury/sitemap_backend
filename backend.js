// backend.js
// Nightlife Navigator backend (Express + static JSON + lightweight live-data sim)

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const NodeCache = require("node-cache");

dotenv.config();

const app = express();
app.use(express.json());

// CORS: allow all by default, or restrict via env
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
app.use(
  cors(
    ALLOWED_ORIGIN
      ? { origin: ALLOWED_ORIGIN, credentials: false }
      : { origin: "*", credentials: false }
  )
);

// --- Load data files
const DATA_DIR = path.join(__dirname, "data");
const VENUES_PATH = path.join(DATA_DIR, "venues.json");
const EVENTS_PATH = path.join(DATA_DIR, "events.json");
const POSTS_PATH  = path.join(DATA_DIR, "posts.json");

// Helpers to read JSON safely
function readJSON(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to read ${p}:`, e.message);
    return null;
  }
}

// In-memory cache for live data (TTL in seconds; default 5 minutes)
const liveCache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL_SECONDS || "300", 10),
  checkperiod: 60,
});

// ---- Utility: compute live data (simple sim for now)
function generateBusyTimes() {
  // Return hours like your Swift mock uses: hour string + percentage + isPredicted
  // We'll cover a typical evening window.
  const hours = [
    "10AM","11AM","12PM","1PM","2PM","3PM","4PM","5PM",
    "6PM","7PM","8PM","9PM","10PM","11PM","12AM","1AM","2AM","3AM"
  ];
  return hours.map((h, idx) => {
    // simple curve: ramp up after 5pm
    const base = idx < 8 ? 10 + idx * 2 : 20 + (idx - 8) * 10; // just a rough shape
    const percentage = Math.max(0, Math.min(100, Math.round(base + (Math.random() * 10 - 5))));
    return { hour: h, percentage, isPredicted: false };
  });
}

function statusFromOccupancy(pct) {
  if (pct >= 75) return "VERY_BUSY";
  if (pct >= 40) return "BUSY";
  if (pct > 0)   return "QUIET";
  return "UNKNOWN";
}

function computeLiveDataForVenue(venue) {
  // If venue has capacity + currentOccupancy, use that; else derive from busy curve
  const busyTimes = generateBusyTimes();
  const lastPoint = busyTimes[Math.max(0, busyTimes.length - 1)];
  const currentOccupancy =
    venue && typeof venue.capacity === "number"
      ? Math.min(venue.capacity, Math.round((venue.capacity * lastPoint.percentage) / 100))
      : Math.round(200 * (lastPoint.percentage / 100)); // fallback baseline

  const currentPct =
    venue && typeof venue.capacity === "number" && venue.capacity > 0
      ? Math.round((currentOccupancy / venue.capacity) * 100)
      : lastPoint.percentage;

  return {
    currentStatus: statusFromOccupancy(currentPct),
    currentOccupancy,
    busyTimes,
  };
}

// ---- ROUTES

// 1) Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nightlife-backend", time: new Date().toISOString() });
});

// 2) Get all venues (optionally lat/lng, which we just echo in metadata)
app.get("/api/venues", (req, res) => {
  const data = readJSON(VENUES_PATH);
  if (!data || !Array.isArray(data.venues)) {
    return res.status(500).json({ error: "venues.json missing or malformed" });
  }

  const { lat, lng } = req.query;
  const response = {
    venues: data.venues,
    metadata: {
      totalVenues: data.venues.length,
      lastUpdated: new Date().toISOString(),
      location: lat && lng ? { lat: Number(lat), lng: Number(lng) } : null,
    },
  };
  res.json(response);
});

// 3) Get single venue
app.get("/api/venues/:id", (req, res) => {
  const data = readJSON(VENUES_PATH);
  if (!data || !Array.isArray(data.venues)) {
    return res.status(500).json({ error: "venues.json missing or malformed" });
  }
  const venue = data.venues.find(v => v.id === req.params.id);
  if (!venue) return res.status(404).json({ error: "Venue not found" });

  res.json({ venue, lastUpdated: new Date().toISOString() });
});

// 4) Live data for a venue (cached)
app.get("/api/venues/:id/live", (req, res) => {
  const data = readJSON(VENUES_PATH);
  if (!data || !Array.isArray(data.venues)) {
    return res.status(500).json({ error: "venues.json missing or malformed" });
  }
  const venue = data.venues.find(v => v.id === req.params.id);
  if (!venue) return res.status(404).json({ error: "Venue not found" });

  const cacheKey = `live:${venue.id}`;
  let liveData = liveCache.get(cacheKey);
  if (!liveData) {
    liveData = computeLiveDataForVenue(venue);
    liveCache.set(cacheKey, liveData);
  }

  res.json({
    venueId: venue.id,
    liveData,
    lastUpdated: new Date().toISOString(),
  });
});

// 5) Batch live data
app.post("/api/venues/live-batch", (req, res) => {
  const { venueIds } = req.body || {};
  if (!Array.isArray(venueIds)) {
    return res.status(400).json({ error: "Body must include { venueIds: string[] }" });
  }

  const data = readJSON(VENUES_PATH);
  if (!data || !Array.isArray(data.venues)) {
    return res.status(500).json({ error: "venues.json missing or malformed" });
  }

  const results = venueIds
    .map(id => {
      const venue = data.venues.find(v => v.id === id);
      if (!venue) return null;
      const cacheKey = `live:${id}`;
      let liveData = liveCache.get(cacheKey);
      if (!liveData) {
        liveData = computeLiveDataForVenue(venue);
        liveCache.set(cacheKey, liveData);
      }
      return { venueId: id, liveData };
    })
    .filter(Boolean);

  res.json({ results, lastUpdated: new Date().toISOString() });
});

// 6) Events for venue (filter by date=YYYY-MM-DD if provided)
app.get("/api/venues/:id/events", (req, res) => {
  const eventsDoc = readJSON(EVENTS_PATH);
  if (!eventsDoc || !Array.isArray(eventsDoc.events)) {
    return res.status(500).json({ error: "events.json missing or malformed" });
  }
  const vid = req.params.id;
  const dateQ = req.query.date; // YYYY-MM-DD

  let events = eventsDoc.events.filter(e => e.venueId === vid);

  if (dateQ) {
    // Keep events whose startTime falls on that date (UTC comparison)
    events = events.filter(e => {
      try {
        const d = new Date(e.startTime);
        const iso = d.toISOString().slice(0, 10);
        return iso === String(dateQ);
      } catch {
        return false;
      }
    });
  }

  res.json(events);
});

// 7) Sports for venue (stub — UI can handle empty)
app.get("/api/venues/:id/sports", (_req, res) => {
  res.json([]);
});

// 8) Discovery posts (useful for your discovery feed)
app.get("/api/posts", (_req, res) => {
  const postsDoc = readJSON(POSTS_PATH);
  if (!postsDoc || !Array.isArray(postsDoc.posts)) {
    return res.status(500).json({ error: "posts.json missing or malformed" });
  }
  res.json({
    posts: postsDoc.posts,
    lastUpdated: postsDoc.lastUpdated || new Date().toISOString(),
    metadata: postsDoc.metadata || {},
  });
});

// --- Not found & error handlers
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// --- Start server: IMPORTANT: use Railway PORT (must be integer)
const port = parseInt(process.env.PORT || "8080", 10);
if (Number.isNaN(port) || port < 0 || port > 65535) {
  throw new Error("PORT variable must be integer between 0 and 65535");
}

app.listen(port, () => {
  console.log(`✅ API listening on :${port}`);
});
