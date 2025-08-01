const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const geofire = require('geofire-common');
const { parse } = require('node-html-parser'); // Optional for more complex parsing
const express = require('express');
const cors = require('cors');
const { decode } = require('@googlemaps/polyline-codec');

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
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://road-jennie-default-rtdb.firebaseio.com/'
  });
}

const db = admin.database();
const GOOGLE_API_KEY = 'AIzaSyAkKxIEQmlMHgTxq4pd3lzJj6aTK4Zqh28'; 
const app = express();
app.use(cors());
app.use(express.json());
const RESULTS_PER_PAGE = 10;


//UPLOADED
// const cities = [
//   "Ahmedabad", "Chennai", "Kolkata", "Pune", "Jaipur", "Surat",
//   "Lucknow", "Kanpur", "Nagpur", "Indore", "Bhopal", "Visakhapatnam", "Patna", "Vadodara", "Ghaziabad",
//   "Ludhiana", "Agra", "Nashik", "Faridabad", "Rajkot", "Kalyan-Dombivli", "Vasai-Virar", "Varanasi", "Srinagar",
//   "Dhanbad", "Amritsar", "Navi Mumbai", "Prayagraj", "Ranchi", "Howrah", "Coimbatore", "Jabalpur",
//   "Vijayawada", "Jodhpur", "Madurai", "Raipur", "Kota", "Guwahati", "Chandigarh", "Solapur", "Hubballi-Dharwad", "Tiruchirappalli",
//   "Bareilly", "Moradabad", "Mysore", "Tiruppur", "Gurgaon", "Noida", "Jamshedpur", "Bhavnagar", "Warangal", "Salem",
//   "Bhiwandi", "Saharanpur", "Guntur", "Bilaspur", "Udaipur", "Jalandhar", "Thiruvananthapuram", "Bokaro", "Ajmer", "Cuttack",
//   "Panipat", "Loni", "Bikaner", "Asansol", "Nellore", "Kollam", "Shillong", "Aligarh"
// ];
// ["Aurangabad","Bahadarabad","Balapur","Bengaluru","Bhadal","Bhainsi","Bhatramarenahalli","Bommasandra","Borivali Tarf Rahur","CENTRAL DELHI","Chilkamarri","Chintalkunta","DEHRADUN","Dehradun","Delhi","Delhi - Haridwar Rd","Haridwar","Hyderabad","Jamalpur Kalan","Jwalapur","Kamalpur Saini Bas","Kondenahalli","Krishnasagara","Kurmalguda","Meerut","Motichur Range","Mumbai","Muzaffarnagar","New Delhi","Noorpur Panjanhedi","Patancheruvu","RANGA REDDY","Rampur","Roorkee","Secunderabad","Shyampur","Sy.no.62 Himayathnagar (v Moinabad (m","Thane","Vajarahalli"]


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
//         photoUrl: getPhotoUrl(station.photos?.[0]?.photo_reference || null),
//         place_id: station.place_id || "",
//         rating: station.rating || null,
//         user_ratings_total: station.user_ratings_total || null,
//         opening_hours: station.opening_hours?.open_now ?? null
//       };

//       await saveStation(stationData);
//       console.log(`✅ Saved: ${stationData.name} (${parsedCity}, ${state})`);
//     }
//   }

//   console.log("🎉 All stations fetched and saved.");
// }

// main().catch(console.error);

// // Save a station to Firebase
// async function saveStation(data) {
//   const ref = db.ref('CNG_Stations').push(); // Auto-ID
//   await ref.set(data);
// }




///USING FIREBASE

function validateBody(body) {
  return body && 
         typeof body.lat === 'number' && 
         typeof body.lng === 'number' &&
         typeof body.page === 'number' && 
         body.page >= 1;
}

app.post('/nearest-cng', async (req, res) => {
  if (!validateBody(req.body)) {
    return res.status(400).json({ error: 'Invalid input. Provide lat, lng (numbers) and page (number >= 1).' });
  }

  const { lat, lng, page } = req.body;
  const RESULTS_PER_PAGE = 50;

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');
    
    // Check if snapshot exists
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
      // Make sure each document has required fields
      if (data && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        allDocs.push({ 
          id: childSnapshot.key, 
          ...data 
        });
      }
    });

    // Calculate distance and sort
    const withDistance = allDocs
      .map(doc => {
        const distance = geofire.distanceBetween([lat, lng], [doc.latitude, doc.longitude]);
        return { ...doc, distance };
      })
      .sort((a, b) => a.distance - b.distance);

    // Pagination logic with bounds checking
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
    res.status(500).json({ 
      error: 'Internal Server Error',
      details: error.message 
    });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
app.post('/cng-on-route', async (req, res) => {
  const { routePoints, cngMileage, tankCapacity } = req.body;

  if (
    !Array.isArray(routePoints) || routePoints.length < 2 ||
    typeof cngMileage !== 'number' || cngMileage <= 0 ||
    typeof tankCapacity !== 'number' || tankCapacity <= 0
  ) {
    return res.status(400).json({
      error: 'Invalid input. Provide routePoints (array of lat/lng), cngMileage (km/kg), and tankCapacity (kg).'
    });
  }

  const maxRange = cngMileage * tankCapacity;

  try {
    const snapshot = await db.ref('CNG_Stations').once('value');

    if (!snapshot.exists()) {
      return res.json({
        stations: [],
        totalResults: 0
      });
    }

    const allDocs = [];
    snapshot.forEach(childSnapshot => {
      const data = childSnapshot.val();
      if (data && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        allDocs.push({
          id: childSnapshot.key,
          ...data
        });
      }
    });

    const MAX_DISTANCE_FROM_ROUTE = 5; // in km
    const onRouteStations = [];
    let totalDistance = 0;

    for (let i = 1; i < routePoints.length; i++) {
      const prev = routePoints[i - 1];
      const curr = routePoints[i];

      const segmentDistance = geofire.distanceBetween(
        [prev.lat, prev.lng],
        [curr.lat, curr.lng]
      );
      totalDistance += segmentDistance;

      // ✅ Process all segments but only include stations if within range
      if (totalDistance <= maxRange) {
        for (const doc of allDocs) {
          const distance = geofire.distanceBetween(
            [curr.lat, curr.lng],
            [doc.latitude, doc.longitude]
          );

          if (distance <= MAX_DISTANCE_FROM_ROUTE) {
            if (!onRouteStations.some(s => s.id === doc.id)) {
              onRouteStations.push({
                ...doc,
                distance,
                distanceFromStart: parseFloat(totalDistance.toFixed(2))
              });
            }
          }
        }
      }
    }

    // ✅ Double-check for stations near destination point (even if skipped in loop)
    const destination = routePoints[routePoints.length - 1];
    const destDistanceFromStart = routePoints.reduce((sum, point, i) => {
      if (i === 0) return 0;
      return sum + geofire.distanceBetween(
        [routePoints[i - 1].lat, routePoints[i - 1].lng],
        [point.lat, point.lng]
      );
    }, 0);

    if (destDistanceFromStart <= maxRange) {
      for (const doc of allDocs) {
        const distance = geofire.distanceBetween(
          [destination.lat, destination.lng],
          [doc.latitude, doc.longitude]
        );
        if (distance <= MAX_DISTANCE_FROM_ROUTE) {
          if (!onRouteStations.some(s => s.id === doc.id)) {
            onRouteStations.push({
              ...doc,
              distance,
              distanceFromStart: parseFloat(destDistanceFromStart.toFixed(2))
            });
          }
        }
      }
    }

    onRouteStations.sort((a, b) => a.distanceFromStart - b.distanceFromStart);

    res.json({
      stations: onRouteStations,
      totalResults: onRouteStations.length
    });

  } catch (error) {
    console.error('Error fetching on-route stations:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      details: error.message
    });
  }
});
