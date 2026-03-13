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

app.use(cors({ origin: true, credentials: true }));
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

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-env';
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000;

function generateToken(adminId) {
  const payload = { adminId, iat: Date.now(), exp: Date.now() + TOKEN_EXPIRY };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(payloadBase64).digest('hex');
  return `${payloadBase64}.${signature}`;
}

function verifyToken(token) {
  try {
    const decodedToken = decodeURIComponent(token);
    const [payloadStr, signature] = decodedToken.split('.');
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(payloadStr).digest('hex');
    if (signature !== expectedSignature) return null;
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (err) {
    console.error('[VERIFY] Error:', err.message);
    return null;
  }
}

function verifyAdminToken(req, res, next) {
  const token = req.cookies?.adminToken || req.headers?.authorization?.replace('Bearer ', '') || req.headers?.['x-admin-token'];
  if (!token) return res.redirect('/login');
  const payload = verifyToken(token);
  if (!payload) return res.redirect('/login');
  req.adminId = payload.adminId;
  next();
}

/* -------------------- ROUTES -------------------- */

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/admin", verifyAdminToken, (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

/* -------------------- AUTH -------------------- */

app.post('/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: 'Username and password required' });

    const adminDoc = await firestore.collection('admin_users').doc(username).get();
    if (!adminDoc.exists)
      return res.status(401).json({ success: false, message: 'Invalid username or password' });

    if (adminDoc.data().password !== password)
      return res.status(401).json({ success: false, message: 'Invalid username or password' });

    const token = generateToken(username);
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
  if (!token) return res.status(401).json({ valid: false });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ valid: false });
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
  if (!validateBody(req.body))
    return res.status(400).json({ error: 'Invalid input. Provide lat, lng (numbers) and page (number >= 1).' });

  const { lat, lng, page } = req.body;
  const RESULTS_PER_PAGE = 50;

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists())
      return res.json({ stations: [], totalResults: 0, page, resultsPerPage: RESULTS_PER_PAGE, totalPages: 0 });

    const allDocs = [];
    snapshot.forEach(childSnapshot => {
      const data = childSnapshot.val();
      if (data && typeof data.latitude === 'number' && typeof data.longitude === 'number')
        allDocs.push({ id: childSnapshot.key, ...data });
    });

    const withDistance = allDocs
      .map(doc => ({ ...doc, distance: geofire.distanceBetween([lat, lng], [doc.latitude, doc.longitude]) }))
      .sort((a, b) => a.distance - b.distance);

    const startIndex = (page - 1) * RESULTS_PER_PAGE;
    res.json({
      stations: withDistance.slice(startIndex, startIndex + RESULTS_PER_PAGE),
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

  if (!source || !destination ||
    typeof source.lat !== 'number' || typeof source.lng !== 'number' ||
    typeof destination.lat !== 'number' || typeof destination.lng !== 'number') {
    return res.status(400).json({ error: 'Invalid input.' });
  }

  const proximityKm = 5;
  const minDistanceFromSource = 5;
  const minDistanceFromDestination = 5;

  try {
    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${source.lat},${source.lng}&destination=${destination.lat},${destination.lng}&key=${GOOGLE_API_KEY}`;
    const directionsResponse = await axios.get(directionsUrl);
    const route = directionsResponse.data.routes?.[0];
    if (!route || !route.overview_polyline)
      return res.status(400).json({ error: 'No route found.' });

    const routePoints = decode(route.overview_polyline.points).map(point => {
      if (Array.isArray(point)) return { lat: point[0], lng: point[1] };
      if (point.lat !== undefined) return { lat: point.lat, lng: point.lng };
      if (point.latitude !== undefined) return { lat: point.latitude, lng: point.longitude };
      return null;
    }).filter(Boolean);

    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists()) return res.json({ stations: [] });

    const allStations = [];
    snapshot.forEach(child => {
      const data = child.val();
      const lat = Number(data.latitude);
      const lng = Number(data.longitude);
      if (!isNaN(lat) && !isNaN(lng))
        allStations.push({ id: child.key, latitude: lat, longitude: lng, ...data });
    });

    const stationsAlongRoute = allStations.map(station => {
      const distanceFromSource = geolib.getDistance(
        { latitude: source.lat, longitude: source.lng },
        { latitude: station.latitude, longitude: station.longitude }
      ) / 1000;

      const distanceFromDestination = geolib.getDistance(
        { latitude: destination.lat, longitude: destination.lng },
        { latitude: station.latitude, longitude: station.longitude }
      ) / 1000;

      let minDistance = Infinity;
      let closestIndex = -1;
      routePoints.forEach((point, index) => {
        const d = geolib.getDistance(
          { latitude: station.latitude, longitude: station.longitude },
          { latitude: point.lat, longitude: point.lng }
        );
        if (d < minDistance) { minDistance = d; closestIndex = index; }
      });

      const distanceFromRouteKm = minDistance / 1000;
      if (distanceFromRouteKm <= proximityKm &&
          distanceFromSource >= minDistanceFromSource &&
          distanceFromDestination >= minDistanceFromDestination) {
        return {
          ...station,
          closestRouteIndex: closestIndex,
          distanceKm: Number(distanceFromRouteKm.toFixed(2)),
          distanceFromSourceKm: Number(distanceFromSource.toFixed(2)),
          distanceFromDestinationKm: Number(distanceFromDestination.toFixed(2))
        };
      }
      return null;
    }).filter(Boolean).sort((a, b) => a.closestRouteIndex - b.closestRouteIndex);

    res.json({ stations: stationsAlongRoute });
  } catch (error) {
    console.error('Route stations error:', error.message);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

/* -------------------- CRON / NEWS -------------------- */

async function fetchAndStoreCarNews() {
  try {
    const { data } = await axios.get("https://gnews.io/api/v4/search", {
      params: {
        q: '(automobile OR automotive OR car OR EV OR "electric vehicle" OR "car launch" OR "car review") AND India',
        max: 40,
        sortby: "date",
        token: process.env.API_KEY_GNEWS
      }
    });

    const news = data.articles
      .filter(a => a.image && a.title)
      .map(a => ({
        title: a.title,
        imagelink: a.image,
        desc: a.description || "",
        newslink: a.url,
        time: a.publishedAt || "Recently",
        cat: "Automotive",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }));

    const batch = firestore.batch();
    const newsCollection = firestore.collection("car_news");
    const oldDocs = await newsCollection.get();
    oldDocs.forEach(doc => batch.delete(doc.ref));
    news.forEach(item => batch.set(newsCollection.doc(), item));
    await batch.commit();
    console.log(`Saved ${news.length} news articles`);
  } catch (error) {
    console.error("News cron error:", error.message);
  }
}

app.get("/api/cron-news", async (req, res) => {
  await fetchAndStoreCarNews();
  res.json({ success: true });
});

app.get("/car-travel-news", async (req, res) => {
  try {
    const snapshot = await firestore.collection("car_news").orderBy("createdAt", "desc").limit(40).get();
    const news = [];
    snapshot.forEach(doc => news.push(doc.data()));
    res.json({ success: true, count: news.length, news });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, news: [] });
  }
});

/* -------------------- API: STATIONS BY CITY -------------------- */

app.get('/stations-by-city', async (req, res) => {
  const city = req.query.city;
  if (!city || typeof city !== 'string')
    return res.status(400).json({ success: false, error: 'Provide a valid city name' });

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists()) return res.json({ success: true, count: 0, stations: [] });

    const stations = [];
    snapshot.forEach(child => {
      const data = child.val();
      if (data.city && data.city.toLowerCase() === city.toLowerCase())
        stations.push({ id: child.key, ...data });
    });

    res.json({ success: true, count: stations.length, stations });
  } catch (err) {
    console.error('Error fetching by city:', err.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

/* -------------------- API: LOOKUP PLACE ID -------------------- */

app.get('/lookup-place-id', async (req, res) => {
  const { name, city } = req.query;
  if (!name)
    return res.status(400).json({ found: false, error: 'Station name is required' });

  try {
    const query = city ? `${name} CNG station ${city} India` : `${name} CNG station India`;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}`;
    const response = await axios.get(url);
    const results = response.data.results;

    if (results && results.length > 0) {
      const place = results[0];
      return res.json({
        found: true,
        place_id: place.place_id,
        name: place.name,
        address: place.formatted_address,
        lat: place.geometry?.location?.lat,
        lng: place.geometry?.location?.lng
      });
    }
    return res.json({ found: false });
  } catch (err) {
    console.error('Place ID lookup error:', err.message);
    res.status(500).json({ found: false, error: 'Lookup failed' });
  }
});

/* -------------------- API: UPDATE STATION -------------------- */

app.post('/update-station/:id', async (req, res) => {
  const stationId = req.params.id;
  const data = req.body;
  if (!stationId) return res.status(400).json({ success: false, error: 'Station ID is required' });

  try {
    const stationRef = db.ref(`CNG_Stations/${stationId}`);
    const snapshot = await stationRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ success: false, error: 'Station not found' });

    await stationRef.update({
      name: data.name,
      address: data.address,
      city: data.city,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      pincode: data.pincode,
      rating: Number(data.rating),
      user_ratings_total: Number(data.user_ratings_total),
      place_id: data.place_id || '',   // ✅ included
    });

    res.json({ success: true, message: 'Station updated successfully' });
  } catch (err) {
    console.error('Error updating station:', err.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

/* -------------------- API: UPDATE STATION WITH IMAGE -------------------- */

app.post('/update-station-with-image/:id', upload.single('photo'), async (req, res) => {
  const stationId = req.params.id;
  const data = req.body;
  const file = req.file;
  if (!stationId) return res.status(400).json({ success: false, error: 'Station ID required' });

  try {
    const stationRef = db.ref(`CNG_Stations/${stationId}`);
    const snapshot = await stationRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ success: false, error: 'Station not found' });

    // Preserve existing photoUrl if no new file uploaded
    let photoUrl = snapshot.val().photoUrl || '';

    if (file) {
      const bucket = getStorage().bucket();
      const fileName = `station_photos/${stationId}_${Date.now()}_${file.originalname}`;
      const fileRef = bucket.file(fileName);
      await fileRef.save(file.buffer, {
        contentType: file.mimetype,
        public: true,
        metadata: { firebaseStorageDownloadTokens: stationId }
      });
      photoUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    }

    await stationRef.update({
      name: data.name,
      address: data.address,
      city: data.city,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      pincode: data.pincode,
      rating: Number(data.rating),
      user_ratings_total: Number(data.user_ratings_total),
      place_id: data.place_id || '',   // ✅ fixed — was missing before
      photoUrl
    });

    res.json({ success: true, message: 'Station updated successfully', photoUrl });
  } catch (err) {
    console.error('Error updating station with image:', err);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

/* -------------------- API: ADD STATION -------------------- */

app.post("/add-station", upload.single("photo"), async (req, res) => {
  try {
    const { name, address, city, pincode, latitude, longitude, rating, place_id, user_ratings_total } = req.body;

    const newRef = db.ref("CNG_Stations").push();
    const stationId = newRef.key;

    let photoUrl = req.body.photoUrl || ""; // Google photo URL fallback

    if (req.file) {
      const bucket = getStorage().bucket();
      const fileName = `station_photos/${stationId}_${Date.now()}_${req.file.originalname}`;
      const fileRef = bucket.file(fileName);
      await fileRef.save(req.file.buffer, { contentType: req.file.mimetype, public: true });
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
      opening_hours: true,
      place_id: place_id || ""
    });

    res.json({ success: true, id: stationId });
  } catch (err) {
    console.error("ADD STATION ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- START SERVER -------------------- */

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

server.on('error', (err) => { console.error('Server error:', err); process.exit(1); });
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); process.exit(1); });