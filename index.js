const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const geofire = require('geofire-common');
const { parse } = require('node-html-parser'); // Optional for more complex parsing
const express = require('express');
const cors = require('cors');

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
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL)}`,
}; 

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const GOOGLE_API_KEY = 'AIzaSyAkKxIEQmlMHgTxq4pd3lzJj6aTK4Zqh28'; 
const app = express();
app.use(cors());
app.use(express.json());
const RESULTS_PER_PAGE = 10;


async function test() {
  try {
    const snapshot = await db.collection('CNG_Stations').limit(1).get();
    console.log('Test query succeeded:', snapshot.size);
  } catch (err) {
    console.error('Test query failed:', err);
  }
}

test();

// List of major Indian cities or areas

// const cities = [
//   "Delhi", "Mumbai", "Pune", "Bangalore", "Hyderabad", "Ahmedabad",
//   "Chennai", "Kolkata", "Jaipur", "Lucknow", "Surat", "Nagpur",
//   "Indore", "Patna", "Bhopal", "Chandigarh", "Gurgaon", "Noida"
// ];

// // Extract city, state, pincode from formatted address
// function extractAddressParts(address) {
//   const parts = address.split(',').map(p => p.trim());
//   const len = parts.length;

//   return {
//     city: len >= 3 ? parts[len - 3] : "",
//     state: len >= 2 ? parts[len - 2].split(" ")[0] : "",
//     pincode: len >= 2 ? parts[len - 2].match(/\d{6}/)?.[0] || "" : ""
//   };
// }

// // Construct photo URL from photo_reference
// function getPhotoUrl(photoRef) {
//   return photoRef
//     ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoRef}&key=${GOOGLE_API_KEY}`
//     : null;
// }

// // Fetch CNG stations for a city using Google Places API
// async function fetchStations(city) {
// let results = [];
//   let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=cng station in ${encodeURIComponent(city)}&key=${GOOGLE_API_KEY}`;
//   let nextPageToken = null;

//   do {
//     const response = await axios.get(url);
//     results = results.concat(response.data.results);

//     nextPageToken = response.data.next_page_token;
//     if (nextPageToken) {
//       // According to Google API, you must wait a short time before requesting next page
//       await new Promise(resolve => setTimeout(resolve, 2000)); // wait 2 seconds
//       url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${nextPageToken}&key=${GOOGLE_API_KEY}`;
//     }
//   } while (nextPageToken && results.length < 50);

//   return results.slice(0, 50); 
// }

// // Save a station to Firestore
// async function saveStation(data) {
//   const docRef = db.collection('CNG_Stations').doc(); // Auto-ID
//   await docRef.set(data);
// }

// // Main function to fetch and save data
// async function main() {
//   for (const city of cities) {
//     console.log(`🔍 Fetching CNG stations for ${city}...`);
//     const results = await fetchStations(city);

//     for (const station of results) {
//       const { lat, lng } = station.geometry.location;
//       const geohash = geofire.geohashForLocation([lat, lng]);
//       const address = station.formatted_address || "";
//       const { city: parsedCity, state, pincode } = extractAddressParts(address);

//       const stationData = {
//         name: station.name || "",
//         address,
//         city: parsedCity || city,
//         state,
//         pincode,
//         latitude: lat,
//         longitude: lng,
//         geohash,
//         photoUrl: getPhotoUrl(station.photos?.[0]?.photo_reference || null)
//       };

//       await saveStation(stationData);
//       console.log(`✅ Saved: ${stationData.name} (${parsedCity}, ${state})`);
//     }
//   }

//   console.log("🎉 All stations fetched and saved.");
// }

// main().catch(console.error);


function validateBody(body) {
  if (
    typeof body.lat !== 'number' ||
    typeof body.lng !== 'number' ||
    typeof body.page !== 'number' ||
    body.page < 1
  ) {
    return false;
  }
  return true;
}

app.post('/nearest-cng', async (req, res) => {
  if (!validateBody(req.body)) {
    return res.status(400).json({ error: 'Invalid input. Provide lat, lng (numbers) and page (number >= 1).' });
  }

  const { lat, lng, page } = req.body;

  try {
    // Fetch all stations (or limit to a reasonable large number if dataset is huge)
    const snapshot = await db.collection('CNG_Stations').get();

    const allDocs = [];
    snapshot.forEach(doc => {
      allDocs.push({ id: doc.id, ...doc.data() });
    });

    // Calculate exact distance to each station
    const withDistance = allDocs
      .map(doc => {
        const distance = geofire.distanceBetween([lat, lng], [doc.latitude, doc.longitude]);
        return { ...doc, distance };
      })
      .sort((a, b) => a.distance - b.distance);

    // Pagination logic
    const RESULTS_PER_PAGE = 10;
    const startIndex = (page - 1) * RESULTS_PER_PAGE;
    const pagedResults = withDistance.slice(startIndex, startIndex + RESULTS_PER_PAGE);

    res.json({
      results: pagedResults,
      totalResults: withDistance.length,
      page,
      resultsPerPage: RESULTS_PER_PAGE,
      totalPages: Math.ceil(withDistance.length / RESULTS_PER_PAGE),
    });
  } catch (error) {
    console.error('Error fetching nearest stations:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
