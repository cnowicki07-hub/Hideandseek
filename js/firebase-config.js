// Paste your Firebase project's web config here.
// Firebase console > Project settings > General > Your apps > Web app > Config.
// This is a public client config — safe to commit, safe to expose in the browser.

const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
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

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
