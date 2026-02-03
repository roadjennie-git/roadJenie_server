const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const geofire = require('geofire-common');
const { parse } = require('node-html-parser');
const express = require('express');
const cors = require('cors');
const geolib = require('geolib');
const { decode } = require('@googlemaps/polyline-codec');
const path = require("path");

// ✅ Create express app ONCE
const app = express();

// Serve HTML + static files
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


// Enable JSON + CORS
app.use(cors());
app.use(express.json());

/* -------------------- FIREBASE SETUP -------------------- */

const serviceAccount = {
  type: 'service_account',
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL)}`
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://road-jennie-default-rtdb.firebaseio.com/'
  });
}

const db = admin.database();
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

/* -------------------- VALIDATION -------------------- */

function validateBody(body) {
  return body &&
    typeof body.lat === 'number' &&
    typeof body.lng === 'number' &&
    typeof body.page === 'number' &&
    body.page >= 1;
}

/* -------------------- API: NEAREST CNG -------------------- */

app.post('/nearest-cng', async (req, res) => {
  if (!validateBody(req.body)) {
    return res.status(400).json({
      error: 'Invalid input. Provide lat, lng (numbers) and page (number >= 1).'
    });
  }

  const { lat, lng, page } = req.body;
  const RESULTS_PER_PAGE = 50;

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');

    if (!snapshot.exists()) {
      return res.json({
        stations: [],
        totalResults: 0,
        page,
        resultsPerPage: RESULTS_PER_PAGE,
        totalPages: 0
      });
    }

    const allDocs = [];
    snapshot.forEach(childSnapshot => {
      const data = childSnapshot.val();
      if (data && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        allDocs.push({ id: childSnapshot.key, ...data });
      }
    });

    const withDistance = allDocs
      .map(doc => {
        const distance = geofire.distanceBetween([lat, lng], [doc.latitude, doc.longitude]);
        return { ...doc, distance };
      })
      .sort((a, b) => a.distance - b.distance);

    const startIndex = (page - 1) * RESULTS_PER_PAGE;
    const endIndex = startIndex + RESULTS_PER_PAGE;

    const pagedResults = withDistance.slice(startIndex, endIndex);

    res.json({
      stations: pagedResults,
      totalResults: withDistance.length,
      page: Math.min(page, Math.ceil(withDistance.length / RESULTS_PER_PAGE)),
      resultsPerPage: RESULTS_PER_PAGE,
      totalPages: Math.ceil(withDistance.length / RESULTS_PER_PAGE),
    });

  } catch (error) {
    console.error('Error fetching nearest stations:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

/* -------------------- API: ROUTE STATIONS -------------------- */

app.post('/stations-along-route', async (req, res) => {
  const { source, destination } = req.body;

  if (
    !source || !destination ||
    typeof source.lat !== 'number' || typeof source.lng !== 'number' ||
    typeof destination.lat !== 'number' || typeof destination.lng !== 'number'
  ) {
    return res.status(400).json({
      error: 'Invalid input. Provide source and destination with lat and lng as numbers.'
    });
  }

  const proximityKm = 5;          // how far station can be from route
  const minFromOriginKm = 5;      // minimum distance from start
  const minBeforeDestKm = 5;      // minimum distance before destination

  try {
    // 1️⃣ Get route from Google Directions
    const directionsUrl =
      `https://maps.googleapis.com/maps/api/directions/json?origin=${source.lat},${source.lng}` +
      `&destination=${destination.lat},${destination.lng}&key=${GOOGLE_API_KEY}`;

    const directionsResponse = await axios.get(directionsUrl);
    const route = directionsResponse.data.routes[0];

    if (!route || !route.overview_polyline) {
      return res.status(400).json({ error: 'No route found.' });
    }

    const routePoints = decode(route.overview_polyline.points);

    // 2️⃣ Fetch all CNG stations
    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists()) {
      return res.json({ stations: [] });
    }

    const allStations = [];
    snapshot.forEach(child => {
      const data = child.val();
      if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        allStations.push({ id: child.key, ...data });
      }
    });

    const originPoint = {
      latitude: source.lat,
      longitude: source.lng
    };

    const destinationPoint = {
      latitude: destination.lat,
      longitude: destination.lng
    };

    // 3️⃣ Filter stations along route with constraints
    const stationsAlongRoute = allStations
      .map(station => {
        let minDistance = Infinity;
        let closestIndex = -1;

        routePoints.forEach((point, index) => {
          const distance = geolib.getDistance(
            { latitude: station.latitude, longitude: station.longitude },
            { latitude: point.lat, longitude: point.lng }
          );

          if (distance < minDistance) {
            minDistance = distance;
            closestIndex = index;
          }
        });

        const distanceFromOriginKm =
          geolib.getDistance(originPoint, {
            latitude: station.latitude,
            longitude: station.longitude
          }) / 1000;

        const distanceToDestinationKm =
          geolib.getDistance(destinationPoint, {
            latitude: station.latitude,
            longitude: station.longitude
          }) / 1000;

        // Conditions:
        // - Near route
        // - Not within first 5 km
        // - Not within last 5 km
        if (
          minDistance / 1000 <= proximityKm &&
          distanceFromOriginKm >= minFromOriginKm &&
          distanceToDestinationKm >= minBeforeDestKm
        ) {
          return {
            ...station,
            closestRouteIndex: closestIndex,
            distanceFromOriginKm: Number(distanceFromOriginKm.toFixed(2)),
            distanceToDestinationKm: Number(distanceToDestinationKm.toFixed(2))
          };
        }

        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.closestRouteIndex - b.closestRouteIndex);

    // 4️⃣ Response
    res.json({
      count: stationsAlongRoute.length,
      stations: stationsAlongRoute
    });

  } catch (error) {
    console.error('Error finding stations along route:', error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      details: error.message
    });
  }
});

/* -------------------- START SERVER -------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

