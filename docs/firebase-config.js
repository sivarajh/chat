// ---------------------------------------------------------------------------
// Firebase configuration.
//
// Paste the config object from YOUR Firebase project below. Get it from:
//   Firebase Console -> Project settings -> "Your apps" -> Web app -> Config
//
// These values are NOT secret. Firebase web config is meant to ship to the
// browser — every visitor's browser must receive it for the app to work, so it
// cannot be kept private, whether or not it lives in this repo.
//
// GitHub's secret scanner still flags `apiKey` because Google uses the same key
// format for billable APIs (Maps, Cloud). For Firebase it's a project
// identifier, not a credential: it grants no data access on its own.
//
// What actually protects you (see the README's "About that Google API Key
// alert" section):
//   1. Firestore Security Rules  -> control who can read/write data.
//   2. API key restrictions      -> lock the key to your own site's domain.
// ---------------------------------------------------------------------------

export const firebaseConfig = {
  apiKey: "AIzaSyCFd-5U9jIViCSIjBarapAyR68R_dTqqyM",
  authDomain: "chat-b0eed.firebaseapp.com",
  projectId: "chat-b0eed",
  storageBucket: "chat-b0eed.firebasestorage.app",
  messagingSenderId: "788992065727",
  appId: "1:788992065727:web:86452595c804ab8cbe860a",
  measurementId: "G-FE2KP9HGBM"
};
