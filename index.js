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

/* -------------------- LOGGER -------------------- */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function log(level, category, message, meta = {}) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    ...(Object.keys(meta).length > 0 && { meta }),
  };
  const output = JSON.stringify(entry);
  if (level === 'ERROR' || level === 'WARN') {
    console.error(output);
  } else {
    console.log(output);
  }
}

const logger = {
  debug: (cat, msg, meta) => log('DEBUG', cat, msg, meta),
  info:  (cat, msg, meta) => log('INFO',  cat, msg, meta),
  warn:  (cat, msg, meta) => log('WARN',  cat, msg, meta),
  error: (cat, msg, meta) => log('ERROR', cat, msg, meta),
};

/* -------------------- REQUEST LOGGING MIDDLEWARE -------------------- */

app.use((req, res, next) => {
  const start = Date.now();
  const { method, url, ip } = req;

  logger.info('HTTP', `${method} ${url}`, { ip, userAgent: req.headers['user-agent'] });

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('HTTP', `${method} ${url} → ${res.statusCode}`, { ip, statusCode: res.statusCode, durationMs: duration });
  });

  next();
});

/* -------------------- FIREBASE SETUP -------------------- */

logger.info('INIT', 'Setting up Firebase...');

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
  logger.info('INIT', 'Firebase initialized successfully', { projectId: process.env.FIREBASE_PROJECT_ID });
} else {
  logger.debug('INIT', 'Firebase already initialized — skipping');
}

const db = admin.database();
const firestore = admin.firestore();
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-env';
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000;

if (!process.env.JWT_SECRET) {
  logger.warn('AUTH', 'JWT_SECRET not set in environment — using insecure default');
}

function generateToken(adminId) {
  logger.debug('AUTH', 'Generating token', { adminId });
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
    if (signature !== expectedSignature) {
      logger.warn('AUTH', 'Token signature mismatch');
      return null;
    }
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64').toString());
    if (payload.exp < Date.now()) {
      logger.warn('AUTH', 'Token expired', { adminId: payload.adminId, expiredAt: new Date(payload.exp).toISOString() });
      return null;
    }
    return payload;
  } catch (err) {
    logger.error('AUTH', 'Token verification error', { error: err.message });
    return null;
  }
}

function verifyAdminToken(req, res, next) {
  const token = req.cookies?.adminToken || req.headers?.authorization?.replace('Bearer ', '') || req.headers?.['x-admin-token'];
  if (!token) {
    logger.warn('AUTH', 'Admin route accessed without token', { url: req.url, ip: req.ip });
    return res.redirect('/login');
  }
  const payload = verifyToken(token);
  if (!payload) {
    logger.warn('AUTH', 'Admin route accessed with invalid/expired token', { url: req.url, ip: req.ip });
    return res.redirect('/login');
  }
  logger.debug('AUTH', 'Admin token verified', { adminId: payload.adminId });
  req.adminId = payload.adminId;
  next();
}

/* -------------------- ROUTES -------------------- */

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/admin", verifyAdminToken, (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

/* -------------------- AUTH -------------------- */

app.post('/admin-login', async (req, res) => {
  const { username, password } = req.body;
  logger.info('AUTH', 'Login attempt', { username, ip: req.ip });

  try {
    if (!username || !password) {
      logger.warn('AUTH', 'Login attempt with missing credentials', { ip: req.ip });
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    const adminDoc = await firestore.collection('admin_users').doc(username).get();
    if (!adminDoc.exists) {
      logger.warn('AUTH', 'Login failed — user not found', { username, ip: req.ip });
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    if (adminDoc.data().password !== password) {
      logger.warn('AUTH', 'Login failed — wrong password', { username, ip: req.ip });
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    const token = generateToken(username);
    res.cookie('adminToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: TOKEN_EXPIRY,
      path: '/'
    });

    logger.info('AUTH', 'Login successful', { username, ip: req.ip });
    res.json({ success: true, message: 'Login successful', token });
  } catch (error) {
    logger.error('AUTH', 'Login error', { username, error: error.message, stack: error.stack });
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

app.post('/verify-token', (req, res) => {
  const token = req.cookies?.adminToken || req.headers?.authorization?.replace('Bearer ', '') || req.headers?.['x-admin-token'];
  if (!token) {
    logger.debug('AUTH', 'Token verification — no token provided');
    return res.status(401).json({ valid: false });
  }
  const payload = verifyToken(token);
  if (!payload) {
    logger.debug('AUTH', 'Token verification — invalid or expired');
    return res.status(401).json({ valid: false });
  }
  logger.debug('AUTH', 'Token verified successfully', { adminId: payload.adminId });
  res.json({ valid: true, adminId: payload.adminId });
});

app.post('/admin-logout', (req, res) => {
  const token = req.cookies?.adminToken;
  logger.info('AUTH', 'Admin logout', { ip: req.ip });
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
    logger.warn('API', 'Invalid input for /nearest-cng', { body: req.body });
    return res.status(400).json({ error: 'Invalid input. Provide lat, lng (numbers) and page (number >= 1).' });
  }

  const { lat, lng, page } = req.body;
  const RESULTS_PER_PAGE = 50;

  logger.info('API', 'Fetching nearest CNG stations', { lat, lng, page });
  const t0 = Date.now();

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists()) {
      logger.info('API', 'No CNG stations found in database');
      return res.json({ stations: [], totalResults: 0, page, resultsPerPage: RESULTS_PER_PAGE, totalPages: 0 });
    }

    const allDocs = [];
    snapshot.forEach(childSnapshot => {
      const data = childSnapshot.val();
      if (data && typeof data.latitude === 'number' && typeof data.longitude === 'number')
        allDocs.push({ id: childSnapshot.key, ...data });
    });

    logger.debug('API', 'Loaded stations from DB', { totalStations: allDocs.length, durationMs: Date.now() - t0 });

    const withDistance = allDocs
      .map(doc => ({ ...doc, distance: geofire.distanceBetween([lat, lng], [doc.latitude, doc.longitude]) }))
      .sort((a, b) => a.distance - b.distance);

    const startIndex = (page - 1) * RESULTS_PER_PAGE;
    const pageResults = withDistance.slice(startIndex, startIndex + RESULTS_PER_PAGE);

    logger.info('API', 'Nearest CNG stations returned', {
      lat, lng, page,
      returned: pageResults.length,
      total: withDistance.length,
      durationMs: Date.now() - t0,
    });

    res.json({
      stations: pageResults,
      totalResults: withDistance.length,
      page: Math.min(page, Math.ceil(withDistance.length / RESULTS_PER_PAGE)),
      resultsPerPage: RESULTS_PER_PAGE,
      totalPages: Math.ceil(withDistance.length / RESULTS_PER_PAGE),
    });
  } catch (error) {
    logger.error('API', 'Error fetching nearest stations', { lat, lng, page, error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

/* -------------------- API: ROUTE STATIONS -------------------- */

app.post('/stations-along-route', async (req, res) => {
  const { source, destination } = req.body;

  if (!source || !destination ||
    typeof source.lat !== 'number' || typeof source.lng !== 'number' ||
    typeof destination.lat !== 'number' || typeof destination.lng !== 'number') {
    logger.warn('API', 'Invalid input for /stations-along-route', { source, destination });
    return res.status(400).json({ error: 'Invalid input.' });
  }

  logger.info('API', 'Fetching stations along route', { source, destination });
  const t0 = Date.now();

  const proximityKm = 5;
  const minDistanceFromSource = 5;
  const minDistanceFromDestination = 5;

  try {
    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${source.lat},${source.lng}&destination=${destination.lat},${destination.lng}&key=${GOOGLE_API_KEY}`;
    logger.debug('API', 'Requesting directions from Google Maps', { source, destination });

    const directionsResponse = await axios.get(directionsUrl);
    const route = directionsResponse.data.routes?.[0];
    if (!route || !route.overview_polyline) {
      logger.warn('API', 'No route found from Google Maps', { source, destination });
      return res.status(400).json({ error: 'No route found.' });
    }

    const routePoints = decode(route.overview_polyline.points).map(point => {
      if (Array.isArray(point)) return { lat: point[0], lng: point[1] };
      if (point.lat !== undefined) return { lat: point.lat, lng: point.lng };
      if (point.latitude !== undefined) return { lat: point.latitude, lng: point.longitude };
      return null;
    }).filter(Boolean);

    logger.debug('API', 'Route decoded', { routePointCount: routePoints.length });

    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists()) {
      logger.info('API', 'No CNG stations in database for route query');
      return res.json({ stations: [] });
    }

    const allStations = [];
    snapshot.forEach(child => {
      const data = child.val();
      const lat = Number(data.latitude);
      const lng = Number(data.longitude);
      if (!isNaN(lat) && !isNaN(lng))
        allStations.push({ id: child.key, latitude: lat, longitude: lng, ...data });
    });

    logger.debug('API', 'Loaded all stations for route filtering', { totalStations: allStations.length });

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

    logger.info('API', 'Stations along route computed', {
      source, destination,
      totalStations: allStations.length,
      matchedStations: stationsAlongRoute.length,
      durationMs: Date.now() - t0,
    });

    res.json({ stations: stationsAlongRoute });
  } catch (error) {
    logger.error('API', 'Route stations error', { source, destination, error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

/* -------------------- CRON / NEWS -------------------- */

async function fetchAndStoreCarNews() {
  logger.info('CRON', 'Starting car news fetch...');
  const t0 = Date.now();

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

    logger.debug('CRON', 'News articles fetched from GNews', { total: data.articles.length, filtered: news.length });

    const batch = firestore.batch();
    const newsCollection = firestore.collection("car_news");
    const oldDocs = await newsCollection.get();
    oldDocs.forEach(doc => batch.delete(doc.ref));
    news.forEach(item => batch.set(newsCollection.doc(), item));
    await batch.commit();

    logger.info('CRON', 'Car news updated successfully', { articlesStored: news.length, durationMs: Date.now() - t0 });
  } catch (error) {
    logger.error('CRON', 'News cron failed', { error: error.message, stack: error.stack });
  }
}

app.get("/api/cron-news", async (req, res) => {
  logger.info('CRON', 'Manual cron trigger via /api/cron-news', { ip: req.ip });
  await fetchAndStoreCarNews();
  res.json({ success: true });
});

app.get("/car-travel-news", async (req, res) => {
  logger.info('API', 'Fetching car news from Firestore');
  try {
    const snapshot = await firestore.collection("car_news").orderBy("createdAt", "desc").limit(40).get();
    const news = [];
    snapshot.forEach(doc => news.push(doc.data()));
    logger.info('API', 'Car news returned', { count: news.length });
    res.json({ success: true, count: news.length, news });
  } catch (err) {
    logger.error('API', 'Error fetching car news', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: err.message, news: [] });
  }
});

/* -------------------- API: STATIONS BY CITY -------------------- */

app.get('/stations-by-city', async (req, res) => {
  const city = req.query.city;
  if (!city || typeof city !== 'string') {
    logger.warn('API', 'Invalid city param for /stations-by-city', { city });
    return res.status(400).json({ success: false, error: 'Provide a valid city name' });
  }

  logger.info('API', 'Fetching stations by city', { city });
  const t0 = Date.now();

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');
    if (!snapshot.exists()) {
      logger.info('API', 'No stations in DB for city query', { city });
      return res.json({ success: true, count: 0, stations: [] });
    }

    const stations = [];
    snapshot.forEach(child => {
      const data = child.val();
      if (data.city && data.city.toLowerCase() === city.toLowerCase())
        stations.push({ id: child.key, ...data });
    });

    logger.info('API', 'Stations by city returned', { city, count: stations.length, durationMs: Date.now() - t0 });
    res.json({ success: true, count: stations.length, stations });
  } catch (err) {
    logger.error('API', 'Error fetching stations by city', { city, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

/* -------------------- API: LOOKUP PLACE ID -------------------- */

app.get('/lookup-place-id', async (req, res) => {
  const { name, city } = req.query;
  if (!name) {
    logger.warn('API', 'Missing name param for /lookup-place-id');
    return res.status(400).json({ found: false, error: 'Station name is required' });
  }

  logger.info('API', 'Looking up place ID', { name, city });

  try {
    const query = city ? `${name} CNG station ${city} India` : `${name} CNG station India`;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}`;
    const response = await axios.get(url);
    const results = response.data.results;

    if (results && results.length > 0) {
      const place = results[0];
      logger.info('API', 'Place ID found', { name, city, placeId: place.place_id });
      return res.json({
        found: true,
        place_id: place.place_id,
        name: place.name,
        address: place.formatted_address,
        lat: place.geometry?.location?.lat,
        lng: place.geometry?.location?.lng
      });
    }

    logger.info('API', 'No place ID found', { name, city });
    return res.json({ found: false });
  } catch (err) {
    logger.error('API', 'Place ID lookup error', { name, city, error: err.message, stack: err.stack });
    res.status(500).json({ found: false, error: 'Lookup failed' });
  }
});

/* -------------------- API: UPDATE STATION -------------------- */

app.post('/update-station/:id', async (req, res) => {
  const stationId = req.params.id;
  const data = req.body;
  if (!stationId) {
    logger.warn('API', 'Missing station ID for /update-station');
    return res.status(400).json({ success: false, error: 'Station ID is required' });
  }

  logger.info('API', 'Updating station', { stationId, fields: Object.keys(data) });

  try {
    const stationRef = db.ref(`CNG_Stations/${stationId}`);
    const snapshot = await stationRef.once('value');
    if (!snapshot.exists()) {
      logger.warn('API', 'Station not found for update', { stationId });
      return res.status(404).json({ success: false, error: 'Station not found' });
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
      place_id: data.place_id || '',
    });

    logger.info('API', 'Station updated successfully', { stationId });
    res.json({ success: true, message: 'Station updated successfully' });
  } catch (err) {
    logger.error('API', 'Error updating station', { stationId, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

/* -------------------- API: UPDATE STATION WITH IMAGE -------------------- */

app.post('/update-station-with-image/:id', upload.single('photo'), async (req, res) => {
  const stationId = req.params.id;
  const data = req.body;
  const file = req.file;
  if (!stationId) {
    logger.warn('API', 'Missing station ID for /update-station-with-image');
    return res.status(400).json({ success: false, error: 'Station ID required' });
  }

  logger.info('API', 'Updating station with image', { stationId, hasFile: !!file, fileSize: file?.size });

  try {
    const stationRef = db.ref(`CNG_Stations/${stationId}`);
    const snapshot = await stationRef.once('value');
    if (!snapshot.exists()) {
      logger.warn('API', 'Station not found for image update', { stationId });
      return res.status(404).json({ success: false, error: 'Station not found' });
    }

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
      logger.info('API', 'Photo uploaded to storage', { stationId, fileName, photoUrl });
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
      place_id: data.place_id || '',
      photoUrl
    });

    logger.info('API', 'Station updated with image successfully', { stationId, photoUrl });
    res.json({ success: true, message: 'Station updated successfully', photoUrl });
  } catch (err) {
    logger.error('API', 'Error updating station with image', { stationId, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

/* -------------------- API: DELETE STATION -------------------- */

app.delete('/delete-station/:id', async (req, res) => {
  const stationId = req.params.id;
  if (!stationId) {
    logger.warn('API', 'Missing station ID for /delete-station');
    return res.status(400).json({ success: false, error: 'Station ID required' });
  }

  logger.info('API', 'Deleting station', { stationId });

  try {
    const stationRef = db.ref(`CNG_Stations/${stationId}`);
    const snapshot = await stationRef.once('value');
    if (!snapshot.exists()) {
      logger.warn('API', 'Station not found for deletion', { stationId });
      return res.status(404).json({ success: false, error: 'Station not found' });
    }

    const photoUrl = snapshot.val().photoUrl || '';
    if (photoUrl && photoUrl.includes('storage.googleapis.com')) {
      try {
        const bucket = getStorage().bucket();
        const filePath = photoUrl.split(`${bucket.name}/`)[1];
        if (filePath) {
          await bucket.file(filePath).delete();
          logger.info('API', 'Station photo deleted from storage', { stationId, filePath });
        }
      } catch (e) {
        logger.warn('API', 'Could not delete photo from storage (non-fatal)', { stationId, error: e.message });
      }
    }

    await stationRef.remove();
    logger.info('API', 'Station deleted successfully', { stationId });
    res.json({ success: true, message: 'Station deleted successfully' });
  } catch (err) {
    logger.error('API', 'Error deleting station', { stationId, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

/* -------------------- API: ADD STATION -------------------- */

app.post("/add-station", upload.single("photo"), async (req, res) => {
  const { name, address, city, pincode, latitude, longitude, rating, place_id, user_ratings_total } = req.body;
  logger.info('API', 'Adding new station', { name, city, lat: latitude, lng: longitude, hasPhoto: !!req.file });

  try {
    const newRef = db.ref("CNG_Stations").push();
    const stationId = newRef.key;

    let photoUrl = req.body.photoUrl || "";

    if (req.file) {
      const bucket = getStorage().bucket();
      const fileName = `station_photos/${stationId}_${Date.now()}_${req.file.originalname}`;
      const fileRef = bucket.file(fileName);
      await fileRef.save(req.file.buffer, { contentType: req.file.mimetype, public: true });
      photoUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
      logger.info('API', 'New station photo uploaded', { stationId, fileName });
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

    logger.info('API', 'New station added successfully', { stationId, name, city });
    res.json({ success: true, id: stationId });
  } catch (err) {
    logger.error('API', 'Error adding station', { name, city, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- API: STATION COUNT -------------------- */

app.get('/station-count', async (req, res) => {
  try {
    const snapshot = await db.ref('CNG_Stations').once('value');
    const count = snapshot.exists() ? snapshot.numChildren() : 0;
    logger.info('API', 'Station count returned', { count });
    res.json({ success: true, count });
  } catch (err) {
    logger.error('API', 'Error fetching station count', { error: err.message });
    res.status(500).json({ success: false, count: 0 });
  }
});

/* -------------------- START SERVER -------------------- */

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info('SERVER', `Server started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
});

server.on('error', (err) => {
  logger.error('SERVER', 'Server error', { error: err.message, code: err.code });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('PROCESS', 'Unhandled promise rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('PROCESS', 'Uncaught exception — shutting down', { error: err.message, stack: err.stack });
  process.exit(1);
});