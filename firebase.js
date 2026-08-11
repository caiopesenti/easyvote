import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

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

async function getCurrentUser() {
  if (auth.currentUser) return auth.currentUser;
  const credential = await signInAnonymously(auth);
  return credential.user;
}

export { db, getCurrentUser };
