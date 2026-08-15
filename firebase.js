import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { connectAuthEmulator, getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { connectFirestoreEmulator, getFirestore } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { connectFunctionsEmulator, getFunctions } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-functions.js";

// Reuses the Firebase project from the earlier poll prototype.
const firebaseConfig = {
  apiKey: "AIzaSyDwAeZ4DaMeHQkFFQLblhDp5a9CNUz2idw",
  authDomain: "enquete-ia-sabe-codar.firebaseapp.com",
  projectId: "enquete-ia-sabe-codar",
  storageBucket: "enquete-ia-sabe-codar.firebasestorage.app",
  messagingSenderId: "203499083947",
  appId: "1:203499083947:web:edf857e452bd51a6edffee",
  measurementId: "G-FNND7K7YJ5"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const functions = getFunctions(app, "southamerica-east1");

// Emulator endpoints are enabled only for a locally served browser session.
// Production domains always keep the real Firebase configuration above.
const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);

if (isLocalDevelopment) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

async function getCurrentUser() {
  if (auth.currentUser) return auth.currentUser;
  const credential = await signInAnonymously(auth);
  return credential.user;
}

export { db, functions, getCurrentUser };
