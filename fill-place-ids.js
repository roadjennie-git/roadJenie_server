// /**
//  * fill-place-ids.js
//  * 
//  * Finds all CNG stations in Firebase that are missing a place_id,
//  * looks them up via Google Places API, and updates the database.
//  * 
//  * Usage:
//  *   node fill-place-ids.js
//  * 
//  * Optional flags:
//  *   --dry-run     Print what would be updated without writing to DB
//  *   --limit=50    Only process the first N stations (useful for testing)
//  *   --city=Delhi  Only process stations from a specific city
//  */

// require('dotenv').config();
// const admin = require('firebase-admin');
// const axios = require('axios');

// /* -------------------- CONFIG -------------------- */

// const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
// const DELAY_MS = 200;         // Delay between API calls to avoid rate limiting
// const MAX_RETRIES = 2;        // Retries per station on network error

// /* -------------------- PARSE FLAGS -------------------- */

// const args = process.argv.slice(2);
// const DRY_RUN = args.includes('--dry-run');
// const LIMIT = (() => {
//   const flag = args.find(a => a.startsWith('--limit='));
//   return flag ? parseInt(flag.split('=')[1]) : null;
// })();
// const CITY_FILTER = (() => {
//   const flag = args.find(a => a.startsWith('--city='));
//   return flag ? flag.split('=')[1].toLowerCase() : null;
// })();

// /* -------------------- FIREBASE INIT -------------------- */

// const serviceAccount = {
//   type: 'service_account',
//   project_id: process.env.FIREBASE_PROJECT_ID,
//   private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
//   private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
//   client_email: process.env.FIREBASE_CLIENT_EMAIL,
//   client_id: process.env.FIREBASE_CLIENT_ID,
//   auth_uri: 'https://accounts.google.com/o/oauth2/auth',
//   token_uri: 'https://oauth2.googleapis.com/token',
//   auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
//   client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL)}`
// };

// if (!admin.apps.length) {
//   admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount),
//     databaseURL: 'https://road-jennie-default-rtdb.firebaseio.com/'
//   });
// }

// const db = admin.database();

// /* -------------------- HELPERS -------------------- */

// function sleep(ms) {
//   return new Promise(resolve => setTimeout(resolve, ms));
// }

// /**
//  * Look up a place_id from Google Places API using station name + city.
//  * Falls back to lat/lng nearby search if text search returns nothing.
//  */
// async function fetchPlaceId(station, attempt = 0) {
//   try {
//     // --- Strategy 1: Text search (name + city) ---
//     const query = `${station.name} CNG station ${station.city || ''}`.trim();
//     const textUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
//       `?input=${encodeURIComponent(query)}` +
//       `&inputtype=textquery` +
//       `&fields=place_id,name,formatted_address` +
//       `&key=${GOOGLE_API_KEY}`;

//     const { data: textData } = await axios.get(textUrl);

//     if (textData.candidates && textData.candidates.length > 0) {
//       const match = textData.candidates[0];
//       return { place_id: match.place_id, method: 'text_search', matched_name: match.name };
//     }

//     // --- Strategy 2: Nearby search (lat/lng) if text search fails ---
//     if (station.latitude && station.longitude) {
//       const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
//         `?location=${station.latitude},${station.longitude}` +
//         `&radius=100` +
//         `&type=gas_station` +
//         `&key=${GOOGLE_API_KEY}`;

//       const { data: nearbyData } = await axios.get(nearbyUrl);

//       if (nearbyData.results && nearbyData.results.length > 0) {
//         const match = nearbyData.results[0];
//         return { place_id: match.place_id, method: 'nearby_search', matched_name: match.name };
//       }
//     }

//     return null; // No match found

//   } catch (err) {
//     if (attempt < MAX_RETRIES) {
//       console.warn(`    ⚠ Network error, retrying (${attempt + 1}/${MAX_RETRIES})...`);
//       await sleep(500 * (attempt + 1));
//       return fetchPlaceId(station, attempt + 1);
//     }
//     throw err;
//   }
// }

// /* -------------------- MAIN -------------------- */

// async function main() {
//   console.log('===========================================');
//   console.log('  CNG Stations — Place ID Filler Script');
//   console.log('===========================================');
//   if (DRY_RUN) console.log('  🔍 DRY RUN MODE — no DB writes will occur');
//   if (LIMIT)   console.log(`  📦 LIMIT: processing up to ${LIMIT} stations`);
//   if (CITY_FILTER) console.log(`  🏙  CITY FILTER: ${CITY_FILTER}`);
//   console.log('===========================================\n');

//   if (!GOOGLE_API_KEY) {
//     console.error('❌ GOOGLE_API_KEY is not set in your .env file. Exiting.');
//     process.exit(1);
//   }

//   // 1. Load all stations
//   console.log('📡 Fetching stations from Firebase...');
//   const snapshot = await db.ref('CNG_Stations').once('value');

//   if (!snapshot.exists()) {
//     console.log('❌ No stations found in database.');
//     process.exit(0);
//   }

//   const allStations = [];
//   snapshot.forEach(child => {
//     const data = child.val();
//     allStations.push({ id: child.key, ...data });
//   });

//   console.log(`✅ Total stations in DB: ${allStations.length}`);

//   // 2. Filter: no place_id (or empty string) + optional city filter
//   let targets = allStations.filter(s => !s.place_id || s.place_id.trim() === '');

//   if (CITY_FILTER) {
//     targets = targets.filter(s => s.city && s.city.toLowerCase() === CITY_FILTER);
//   }

//   if (LIMIT) {
//     targets = targets.slice(0, LIMIT);
//   }

//   console.log(`🎯 Stations missing place_id: ${targets.length}\n`);

//   if (targets.length === 0) {
//     console.log('🎉 All stations already have a place_id. Nothing to do!');
//     process.exit(0);
//   }

//   // 3. Process each station
//   const results = { updated: 0, skipped: 0, failed: 0 };
//   const failedStations = [];

//   for (let i = 0; i < targets.length; i++) {
//     const station = targets[i];
//     const prefix = `[${i + 1}/${targets.length}]`;

//     console.log(`${prefix} 🔍 "${station.name || 'Unnamed'}" — ${station.city || 'No city'}`);

//     if (!station.name) {
//       console.log(`         ⚠ Skipping — no name available\n`);
//       results.skipped++;
//       continue;
//     }

//     try {
//       const result = await fetchPlaceId(station);

//       if (result) {
//         console.log(`         ✅ Found via ${result.method}: ${result.place_id}`);
//         console.log(`         📍 Matched: "${result.matched_name}"`);

//         if (!DRY_RUN) {
//           await db.ref(`CNG_Stations/${station.id}`).update({ place_id: result.place_id });
//           console.log(`         💾 Saved to DB`);
//         } else {
//           console.log(`         🔍 [DRY RUN] Would save: ${result.place_id}`);
//         }

//         results.updated++;
//       } else {
//         console.log(`         ❌ No match found — skipping`);
//         results.skipped++;
//         failedStations.push({ id: station.id, name: station.name, city: station.city, reason: 'no_match' });
//       }

//     } catch (err) {
//       console.error(`         💥 Error: ${err.message}`);
//       results.failed++;
//       failedStations.push({ id: station.id, name: station.name, city: station.city, reason: err.message });
//     }

//     console.log('');

//     // Rate limit: pause between requests
//     if (i < targets.length - 1) {
//       await sleep(DELAY_MS);
//     }
//   }

//   /* -------------------- SUMMARY -------------------- */

//   console.log('===========================================');
//   console.log('  DONE — Summary');
//   console.log('===========================================');
//   console.log(`  ✅ Updated : ${results.updated}`);
//   console.log(`  ⚠  Skipped : ${results.skipped}`);
//   console.log(`  ❌ Failed  : ${results.failed}`);
//   console.log('===========================================\n');

//   if (failedStations.length > 0) {
//     console.log('Stations that could not be matched:');
//     failedStations.forEach(s => {
//       console.log(`  • [${s.id}] "${s.name}" (${s.city}) — ${s.reason}`);
//     });
//     console.log('\nTip: For unmatched stations, check the name/city in your DB');
//     console.log('     or add the place_id manually via the Admin dashboard.\n');
//   }

//   process.exit(0);
// }

// main().catch(err => {
//   console.error('Fatal error:', err);
//   process.exit(1);
// });
