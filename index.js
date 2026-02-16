const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const geofire = require('geofire-common');
const { parse } = require('node-html-parser');
const express = require('express');
const cheerio = require("cheerio");
const cors = require('cors');
const geolib = require('geolib');
const { decode } = require('@googlemaps/polyline-codec');
const path = require("path");
const multer = require('multer');
const { getStorage } = require('firebase-admin/storage');
const upload = multer({ storage: multer.memoryStorage() });
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
    storageBucket: 'gs://road-jennie.firebasestorage.app', 
    databaseURL: 'https://road-jennie-default-rtdb.firebaseio.com/'
  });
}

const db = admin.database();
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

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

  console.log('\n========== NEW REQUEST ==========');
  console.log('Received /stations-along-route request');
  console.log('Source:', source);
  console.log('Destination:', destination);

  if (
    !source || !destination ||
    typeof source.lat !== 'number' || typeof source.lng !== 'number' ||
    typeof destination.lat !== 'number' || typeof destination.lng !== 'number'
  ) {
    console.log('Invalid input!');
    return res.status(400).json({
      error: 'Invalid input. Provide source and destination with lat and lng as numbers.'
    });
  }

  const proximityKm = 5; // Distance from route
  const minDistanceFromSource = 5; // Minimum 5km from source
  const minDistanceFromDestination = 5; // Minimum 5km from destination (i.e., 5km before end)

  try {
    // 1️⃣ Get route from Google Directions
    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${source.lat},${source.lng}&destination=${destination.lat},${destination.lng}&key=${GOOGLE_API_KEY}`;
    console.log('\n--- GOOGLE DIRECTIONS API ---');

    const directionsResponse = await axios.get(directionsUrl);
    console.log('API Status:', directionsResponse.data.status);
    
    const route = directionsResponse.data.routes?.[0];

    if (!route || !route.overview_polyline) {
      console.log('No route found!');
      return res.status(400).json({ error: 'No route found.' });
    }

    const decodedPoints = decode(route.overview_polyline.points);
    console.log(`✓ Route decoded. Number of points: ${decodedPoints.length}`);
    
    // Convert to consistent format
    const routePoints = decodedPoints.map(point => {
      if (Array.isArray(point)) {
        return { lat: point[0], lng: point[1] };
      }
      if (point.lat !== undefined && point.lng !== undefined) {
        return { lat: point.lat, lng: point.lng };
      }
      if (point.latitude !== undefined && point.longitude !== undefined) {
        return { lat: point.latitude, lng: point.longitude };
      }
      return null;
    }).filter(Boolean);

    console.log(`✓ Converted route points: ${routePoints.length}`);
    console.log('First 3 converted points:', routePoints.slice(0, 3));

    // 2️⃣ Fetch all CNG stations
    console.log('\n--- FETCHING STATIONS FROM FIREBASE ---');
    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists()) {
      console.log('❌ No stations found in database.');
      return res.json({ stations: [] });
    }

    const allStations = [];
    snapshot.forEach(child => {
      const data = child.val();
      const lat = Number(data.latitude);
      const lng = Number(data.longitude);

      if (!isNaN(lat) && !isNaN(lng)) {
        allStations.push({ id: child.key, latitude: lat, longitude: lng, ...data });
      } else {
        console.warn(`⚠️ Skipping station with invalid coordinates: ${child.key}`);
      }
    });

    console.log(`✓ Total valid stations fetched: ${allStations.length}`);

    // 3️⃣ Filter stations along route with restrictions
    console.log(`\n--- FILTERING STATIONS ---`);
    console.log(`Proximity to route: ≤${proximityKm} km`);
    console.log(`Min distance from source: ≥${minDistanceFromSource} km`);
    console.log(`Min distance from destination: ≥${minDistanceFromDestination} km (stop 5km before end)`);
    
    const stationsAlongRoute = allStations
      .map((station, idx) => {
        if (
          station.latitude == null ||
          station.longitude == null ||
          isNaN(station.latitude) ||
          isNaN(station.longitude)
        ) {
          return null;
        }

        // Calculate distance from source
        const distanceFromSource = geolib.getDistance(
          { latitude: source.lat, longitude: source.lng },
          { latitude: station.latitude, longitude: station.longitude }
        ) / 1000; // Convert to km

        // Calculate distance from destination
        const distanceFromDestination = geolib.getDistance(
          { latitude: destination.lat, longitude: destination.lng },
          { latitude: station.latitude, longitude: station.longitude }
        ) / 1000; // Convert to km

        // Find minimum distance to route
        let minDistance = Infinity;
        let closestIndex = -1;

        routePoints.forEach((point, index) => {
          if (!point || point.lat == null || point.lng == null) return;

          try {
            const distance = geolib.getDistance(
              { latitude: station.latitude, longitude: station.longitude },
              { latitude: point.lat, longitude: point.lng }
            );

            if (distance < minDistance) {
              minDistance = distance;
              closestIndex = index;
            }
          } catch (err) {
            console.error(`Error calculating distance for station ${station.id}:`, err.message);
          }
        });

        const distanceFromRouteKm = minDistance / 1000;

        // Log first 5 stations for debugging
        if (idx < 5) {
          console.log(`\nStation ${idx + 1}: ${station.name || station.id}`);
          console.log(`  Distance from route: ${distanceFromRouteKm.toFixed(2)} km`);
          console.log(`  Distance from source: ${distanceFromSource.toFixed(2)} km`);
          console.log(`  Distance from destination: ${distanceFromDestination.toFixed(2)} km`);
        }

        // Apply all three filters
        if (distanceFromRouteKm <= proximityKm &&
            distanceFromSource >= minDistanceFromSource &&
            distanceFromDestination >= minDistanceFromDestination) {
          
          console.log(`  ✓ Station ${station.id} INCLUDED`);
          console.log(`     - ${distanceFromRouteKm.toFixed(2)} km from route`);
          console.log(`     - ${distanceFromSource.toFixed(2)} km from source`);
          console.log(`     - ${distanceFromDestination.toFixed(2)} km from destination`);
          
          return {
            ...station,
            closestRouteIndex: closestIndex,
            distanceKm: Number(distanceFromRouteKm.toFixed(2)),
            distanceFromSourceKm: Number(distanceFromSource.toFixed(2)),
            distanceFromDestinationKm: Number(distanceFromDestination.toFixed(2))
          };
        }

        // Log why station was excluded (for first 10 stations only)
        if (idx < 10) {
          if (distanceFromRouteKm > proximityKm) {
            console.log(`  ✗ Excluded: Too far from route (${distanceFromRouteKm.toFixed(2)} km)`);
          } else if (distanceFromSource < minDistanceFromSource) {
            console.log(`  ✗ Excluded: Too close to source (${distanceFromSource.toFixed(2)} km < ${minDistanceFromSource} km)`);
          } else if (distanceFromDestination < minDistanceFromDestination) {
            console.log(`  ✗ Excluded: Too close to destination (${distanceFromDestination.toFixed(2)} km < ${minDistanceFromDestination} km)`);
          }
        }

        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.closestRouteIndex - b.closestRouteIndex);

    console.log(`\n========== RESULTS ==========`);
    console.log(`Total stations checked: ${allStations.length}`);
    console.log(`Stations matching all criteria: ${stationsAlongRoute.length}`);
    console.log(`Criteria:`);
    console.log(`  - Within ${proximityKm}km of route`);
    console.log(`  - At least ${minDistanceFromSource}km from source`);
    console.log(`  - At least ${minDistanceFromDestination}km from destination`);
    
    if (stationsAlongRoute.length > 0) {
      console.log('\nStations found along route:');
      stationsAlongRoute.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.name || s.id}`);
        console.log(`     Route: ${s.distanceKm} km | Source: ${s.distanceFromSourceKm} km | Dest: ${s.distanceFromDestinationKm} km`);
      });
    } else {
      console.log('\n❌ NO STATIONS FOUND matching all criteria');
    }
    console.log('================================\n');

    res.json({ stations: stationsAlongRoute });

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});


///NEWS API
app.get("/car-travel-news", async (req, res) => {
  try {
    // const url = "https://auto.economictimes.indiatimes.com/";
    const url = "https://www.google.com/search?sca_esv=2bbc76108a4ecd6f&rlz=1C5GCEM_enIN1185IN1185&sxsrf=ANbL-n7ezxSdvZ16behOuOC4HkRcEjfYJw:1771245154056&q=automobile+news&tbm=nws&source=lnms&fbs=ADc_l-aN0CWEZBOHjofHoaMMDiKp0UJuhqwKhR0QUhF54-6jIX2xhuqmjuyJb8bmeAomNlGvrcIh4D4fHfxBBURfTfoz9NM4d8_XekjXkRztNIuwEfgeouvVtEvct4Xb5ViDaUGqunOLW7cyUaJPqaHGEhik033waife6RWg3EnXFYJkpQy71Ylwy6DO1qfCAlz_skgfErPkat2Mj57brw4X2iPwxEhcVQ&sa=X&ved=2ahUKEwio1d6xgt6SAxWHa2wGHSuZIJYQ0pQJegQIFBAB&biw=736&bih=836&dpr=2";
    
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(data);
    const news = [];

    $("article, .story-box, .eachStory").each((i, el) => {
      const title = $(el).find("h2, h3, .title").text().trim();
      const link = $(el).find("a").attr("href");
      const image = $(el).find("img").attr("src") || $(el).find("img").attr("data-src");
      const description = $(el).find("p, .summary").text().trim();
      const time = $(el).find(".time, .date, time").text().trim() || "Recently";
      const cat = "Automotive";

      if (title && link) {
        news.push({
          title: title,
          imagelink: image && !image.startsWith("http") 
            ? `${url}${image}`  
            : (image || ""),
          desc: description || "",
          newslink: link.startsWith("http") 
            ? link 
            : `${url}${link}`,
          time: time,
          cat: cat
        });
      }
    });

    // Return only the JSON
    res.json({ success: true, count: news.length, news: news });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message, news: [] });
  }
});
///

/* -------------------- API: STATIONS BY CITY -------------------- */

app.get('/stations-by-city', async (req, res) => {
  const city = req.query.city;

  if (!city || typeof city !== 'string') {
    return res.status(400).json({ 
      success: false, 
      error: 'Please provide a valid city name as query parameter, e.g., ?city=Delhi' 
    });
  }

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');

    if (!snapshot.exists()) {
      return res.json({ success: true, count: 0, stations: [] });
    }

    const stations = [];
    snapshot.forEach(child => {
      const data = child.val();
      // Assuming your station object has a "city" field
      if (data.city && data.city.toLowerCase() === city.toLowerCase()) {
        stations.push({ id: child.key, ...data });
      }
    });

    res.json({ success: true, count: stations.length, stations });

  } catch (err) {
    console.error('Error fetching stations by city:', err.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});
/* -------------------- API: UPDATE STATION -------------------- */

app.post('/update-station/:id', async (req, res) => {
  const stationId = req.params.id;
  const data = req.body;

  if (!stationId) {
    return res.status(400).json({ success: false, error: 'Station ID is required' });
  }

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ success: false, error: 'Invalid data' });
  }

  try {
    const stationRef = db.ref(`CNG_Stations/${stationId}`);
    const snapshot = await stationRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }

    // Update only the allowed fields
    const updateData = {
      name: data.name,
      address: data.address,
      city: data.city,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      pincode: data.pincode,
      rating: Number(data.rating),
      user_ratings_total: Number(data.user_ratings_total),
    };

    await stationRef.update(updateData);

    res.json({ success: true, message: 'Station updated successfully' });
  } catch (err) {
    console.error('Error updating station:', err.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// Upload image and update station
app.post('/update-station-with-image/:id', upload.single('photo'), async (req, res) => {
  const stationId = req.params.id;
  const data = req.body;
  const file = req.file; // uploaded file

  if (!stationId) return res.status(400).json({ success: false, error: 'Station ID required' });

  try {
    const stationRef = db.ref(`CNG_Stations/${stationId}`);
    const snapshot = await stationRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ success: false, error: 'Station not found' });

    let photoUrl = data.photoUrl || ''; // default to existing

    // If a new image is uploaded
    if (file) {
      const bucket = getStorage().bucket(); // default bucket
      const fileName = `station_photos/${stationId}_${Date.now()}_${file.originalname}`;
      const fileRef = bucket.file(fileName);

      await fileRef.save(file.buffer, {
        contentType: file.mimetype,
        public: true, // make it publicly accessible
        metadata: { firebaseStorageDownloadTokens: stationId }
      });

      photoUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    }

    // Update station with all fields + photoUrl
    const updateData = {
      name: data.name,
      address: data.address,
      city: data.city,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      pincode: data.pincode,
      rating: Number(data.rating),
      user_ratings_total: Number(data.user_ratings_total),
      photoUrl
    };

    await stationRef.update(updateData);

    res.json({ success: true, message: 'Station updated successfully', photoUrl });

  } catch (err) {
    console.error('Error updating station:', err);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});


/* -------------------- START SERVER -------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
