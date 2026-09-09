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

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
