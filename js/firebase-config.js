// Paste your Firebase project's web config here.
// Firebase console > Project settings > General > Your apps > Web app > Config.
// This is a public client config — safe to commit, safe to expose in the browser.

const firebaseConfig = {
  apiKey: "AIzaSyAGFLEdiXVcK4pQ6vLTF0zFuY9BptNR9hI",
  authDomain: "hide-and-seek-dc4ac.firebaseapp.com",
  projectId: "hide-and-seek-dc4ac",
  storageBucket: "hide-and-seek-dc4ac.firebasestorage.app",
  messagingSenderId: "661703290238",
  appId: "1:661703290238:web:3607a97856ad138643972f",
  measurementId: "G-RZ2M1ZTHNQ",
};

// While the config above is still a placeholder there is nothing to talk to,
// so fall back to the in-memory dev harness (js/devmode.js). Filling in real
// credentials switches this to the real SDK with no other change. ?mock=1
// forces the harness even once credentials exist, for offline rehearsal.
const USE_MOCK_DB =
  firebaseConfig.apiKey === 'REPLACE_ME' ||
  new URLSearchParams(location.search).has('mock');

if (USE_MOCK_DB) {
  window.firebase = window.__mockFirebase;
  console.info('[hide&seek] No Firebase credentials — using in-memory dev harness.');
}

// The SDK comes from gstatic. If that request fails — captive portal, no
// signal, a blocked network — every button on the page would otherwise do
// nothing at all, with no clue why. Say so instead.
if (typeof firebase === 'undefined') {
  document.body.innerHTML =
    '<div style="padding:24px;font:16px/1.5 -apple-system,system-ui,sans-serif;color:#ecf0f1">' +
    '<h1 style="font-size:22px">Can\'t reach Firebase</h1>' +
    '<p>The app loaded but its connection library did not, so nothing would work.</p>' +
    '<p>Usually this means no internet, or a wifi login page waiting to be accepted. ' +
    'Check your connection and reload.</p>' +
    '</div>';
  throw new Error('Firebase SDK failed to load');
}

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
