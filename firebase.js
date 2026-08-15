import { deleteApp, initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  linkWithPopup,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  signInWithCredential,
  signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { connectFirestoreEmulator, getFirestore } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { connectFunctionsEmulator, getFunctions } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-functions.js";

// Keeps the original Firebase project internally while using the public
// EasyVote Hosting site for the OAuth helper/redirect experience.
const firebaseConfig = {
  apiKey: "AIzaSyDwAeZ4DaMeHQkFFQLblhDp5a9CNUz2idw",
  authDomain: "easyvote-polls.web.app",
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

const authSubscribers = new Set();
let authStateUser = auth.currentUser;
let authStateReady = false;
let resolveInitialAuthState;
let anonymousSignInPromise = null;

const initialAuthState = new Promise(resolve => {
  resolveInitialAuthState = resolve;
});
const persistenceReady = setPersistence(auth, browserLocalPersistence).catch(error => {
  console.warn("EasyVote could not set explicit Auth persistence.", error);
});

onAuthStateChanged(auth, user => {
  authStateUser = user;
  if (!authStateReady) {
    authStateReady = true;
    resolveInitialAuthState(user);
  }
  for (const subscriber of authSubscribers) subscriber(user);
});

function subscribeToAuthState(subscriber) {
  authSubscribers.add(subscriber);
  if (authStateReady) queueMicrotask(() => subscriber(authStateUser));
  return () => authSubscribers.delete(subscriber);
}

function getAuthUser() {
  return authStateUser;
}

function isRegisteredUser(user = authStateUser) {
  return Boolean(user && !user.isAnonymous);
}

async function getCurrentUser() {
  await persistenceReady;
  await initialAuthState;
  if (auth.currentUser) return auth.currentUser;

  if (!anonymousSignInPromise) {
    anonymousSignInPromise = signInAnonymously(auth)
      .then(credential => credential.user)
      .finally(() => { anonymousSignInPromise = null; });
  }
  return anonymousSignInPromise;
}

function googleCredentialFromError(error) {
  return GoogleAuthProvider.credentialFromError(error);
}

async function signInWithGoogle(migrateAnonymousPolls) {
  const currentUser = await getCurrentUser();
  if (!currentUser.isAnonymous) return { user: currentUser, linked: false, transferredPolls: 0 };

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    const result = await linkWithPopup(currentUser, provider);
    return { user: result.user, linked: true, transferredPolls: 0 };
  } catch (error) {
    const isExistingCredential = [
      "auth/account-exists-with-different-credential",
      "auth/credential-already-in-use",
      "auth/email-already-in-use"
    ].includes(error?.code);
    if (!isExistingCredential) throw error;

    const googleCredential = googleCredentialFromError(error);
    if (!googleCredential || typeof migrateAnonymousPolls !== "function") throw error;

    // Authenticate the existing Google account in an isolated in-memory Auth
    // instance. The primary anonymous session remains intact until its polls
    // have been transferred successfully by the server.
    const secondaryApp = initializeApp(firebaseConfig, `easyvote-account-merge-${crypto.randomUUID()}`);
    try {
      const secondaryAuth = getAuth(secondaryApp);
      if (isLocalDevelopment) {
        connectAuthEmulator(secondaryAuth, "http://127.0.0.1:9099", { disableWarnings: true });
      }
      await setPersistence(secondaryAuth, inMemoryPersistence);
      const existingAccount = await signInWithCredential(secondaryAuth, googleCredential);
      const targetIdToken = await existingAccount.user.getIdToken(true);
      const migration = await migrateAnonymousPolls(targetIdToken);
      const primaryResult = await signInWithCredential(auth, googleCredential);
      return {
        user: primaryResult.user,
        linked: false,
        transferredPolls: migration?.transferredPolls || 0
      };
    } finally {
      await deleteApp(secondaryApp);
    }
  }
}

async function signOutToGuest() {
  await persistenceReady;
  await signOut(auth);
  return getCurrentUser();
}

export {
  db,
  functions,
  getAuthUser,
  getCurrentUser,
  isRegisteredUser,
  signInWithGoogle,
  signOutToGuest,
  subscribeToAuthState
};
