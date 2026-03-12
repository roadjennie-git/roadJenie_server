const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const cookieParser = require('cookie-parser');
const geofire = require('geofire-common');
const express = require('express');
const cors = require('cors');
const geolib = require('geolib');
const { decode } = require('@googlemaps/polyline-codec');
const path = require("path");
const multer = require('multer');
const crypto = require('crypto');
const { getStorage } = require('firebase-admin/storage');
const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// Enable JSON + CORS + Cookie Parser (BEFORE routes)
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

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
const firestore = admin.firestore();
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// JWT Secret for admin tokens
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-env';
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// Helper: Generate JWT token
function generateToken(adminId) {
  const payload = {
    adminId,
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY
  };
  const payloadStr = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadStr).toString('base64');
  
  // Sign the base64-encoded payload
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payloadBase64)
    .digest('hex');
  
  return `${payloadBase64}.${signature}`;
}

// Helper: Verify JWT token
function verifyToken(token) {
  try {
    // Handle potential URL encoding from cookies
    const decodedToken = decodeURIComponent(token);
    const [payloadStr, signature] = decodedToken.split('.');
    
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(payloadStr)
      .digest('hex');
    
    if (signature !== expectedSignature) {
      console.log('[VERIFY] ❌ Signature mismatch');
      console.log('[VERIFY] Expected:', expectedSignature);
      console.log('[VERIFY] Got:', signature);
      return null;
    }
    
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64').toString());
    if (payload.exp < Date.now()) {
      console.log('[VERIFY] ❌ Token expired');
      return null;
    }
    
    return payload;
  } catch (err) {
    console.error('[VERIFY] Error:', err.message);
    return null;
  }
}

// Middleware: Verify admin token
function verifyAdminToken(req, res, next) {
  const token = req.cookies?.adminToken || req.headers?.authorization?.replace('Bearer ', '') || req.headers?.['x-admin-token'];
  
  if (!token) {
    return res.redirect('/login');
  }
  
  const payload = verifyToken(token);
  if (!payload) {
    return res.redirect('/login');
  }
  
  req.adminId = payload.adminId;
  next();
}

/* -------------------- ROUTES -------------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/admin", verifyAdminToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* -------------------- API: ADMIN AUTHENTICATION -------------------- */

app.post('/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    
    // Fetch admin from Firestore
    const adminRef = firestore.collection('admin_users').doc(username);
    const adminDoc = await adminRef.get();
    
    if (!adminDoc.exists) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    
    const adminData = adminDoc.data();
    
    // Simple password validation (in production, use bcrypt)
    if (adminData.password !== password) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    
    // Generate token
    const token = generateToken(username);
    
    // Set secure HTTP-only cookie
    res.cookie('adminToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: TOKEN_EXPIRY,
      path: '/'
    });
    
    res.json({ success: true, message: 'Login successful', token });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

app.post('/verify-token', (req, res) => {
  const token = req.cookies?.adminToken || req.headers?.authorization?.replace('Bearer ', '') || req.headers?.['x-admin-token'];
  
  console.log('[VERIFY-TOKEN] Checking authentication...');
  console.log('[VERIFY-TOKEN] Cookies received:', { adminToken: req.cookies?.adminToken ? 'YES' : 'NO' });
  console.log('[VERIFY-TOKEN] Auth header:', req.headers?.authorization ? 'YES' : 'NO');
  
  if (!token) {
    console.log('[VERIFY-TOKEN] ❌ No token found');
    return res.status(401).json({ valid: false });
  }
  
  const payload = verifyToken(token);
  if (!payload) {
    console.log('[VERIFY-TOKEN] ❌ Token invalid or expired');
    return res.status(401).json({ valid: false });
  }
  
  console.log('[VERIFY-TOKEN] ✅ Token valid for admin:', payload.adminId);
  res.json({ valid: true, adminId: payload.adminId });
});

app.post('/admin-logout', (req, res) => {
  res.clearCookie('adminToken');
  res.json({ success: true, message: 'Logged out successfully' });
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
///CRON
async function fetchAndStoreCarNews() {
  try {
    console.log("Fetching automobile news...");

    const API_KEY = process.env.API_KEY_GNEWS;

    const { data } = await axios.get("https://gnews.io/api/v4/search", {
      params: {
        q:'(automobile OR automotive OR car OR EV OR "electric vehicle" OR "car launch" OR "car review") AND India',
        max: 40,
        sortby: "date",
        token: API_KEY
      }
    });

    const news = data.articles
      .filter(article => article.image && article.title)
      .map(article => ({
        title: article.title,
        imagelink: article.image,
        desc: article.description || "",
        newslink: article.url,
        time: article.publishedAt || "Recently",
        cat: "Automotive",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }));

    const batch = firestore.batch();
    const newsCollection = firestore.collection("car_news");

    // Clear old news
    const oldDocs = await newsCollection.get();
    oldDocs.forEach(doc => batch.delete(doc.ref));

    // Add new news
    news.forEach(item => {
      const ref = newsCollection.doc();
      batch.set(ref, item);
    });

    await batch.commit();

    console.log(`Saved ${news.length} news articles to Firestore`);
  } catch (error) {
    console.error("News cron error:", error.message);
  }
}
app.get("/api/cron-news", async (req, res) => {
  await fetchAndStoreCarNews();
  res.json({ success: true });
});
///NEWS API - GNews
app.get("/car-travel-news", async (req, res) => {
  try {
    const snapshot = await firestore
  .collection("car_news")
  .orderBy("createdAt", "desc")
  .limit(40)
  .get();

    const news = [];
    snapshot.forEach(doc => news.push(doc.data()));

    res.json({
      success: true,
      count: news.length,
      news
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
      news: []
    });
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

/* -------------------- API: ADD STATION -------------------- */
app.post("/add-station", upload.single("photo"), async (req, res) => {
  try {
    const {
      name,
      address,
      city,
      pincode,
      latitude,
      longitude,
      rating,
      user_ratings_total
    } = req.body;

    const newRef = db.ref("CNG_Stations").push();
    const stationId = newRef.key;

    let photoUrl = "";

    // If image uploaded
    if (req.file) {
      const bucket = getStorage().bucket();
      const fileName = `station_photos/${stationId}_${Date.now()}_${req.file.originalname}`;
      const fileRef = bucket.file(fileName);

      await fileRef.save(req.file.buffer, {
        contentType: req.file.mimetype,
        public: true,
      });

      photoUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    }

    await newRef.set({
      name,
      address,
      city,
      pincode,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      rating: parseFloat(rating || 0),
      user_ratings_total: parseInt(user_ratings_total || 0),
      photoUrl,
      opening_hours: true
    });

    res.json({ success: true, id: stationId });

  } catch (err) {
    console.error("ADD STATION ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- START SERVER -------------------- */

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// Error handling
server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
