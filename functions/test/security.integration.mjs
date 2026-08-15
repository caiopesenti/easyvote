import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInAnonymously } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  setDoc,
  updateDoc
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const projectId = "enquete-ia-sabe-codar";
const app = initializeApp({
  apiKey: "security-test-key",
  appId: "security-test-app",
  projectId
}, "security-integration-test");
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "southamerica-east1");

connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

const createPoll = httpsCallable(functions, "createPoll");
const castVote = httpsCallable(functions, "castVote");

async function expectError(operation, expectedCode) {
  try {
    await operation();
    assert.fail(`Expected ${expectedCode} to be rejected.`);
  } catch (error) {
    assert.equal(error.code, expectedCode);
  }
}

function waitForTotal(pollRef, expectedTotal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the realtime result update."));
    }, 10_000);
    const unsubscribe = onSnapshot(pollRef, snapshot => {
      if (snapshot.exists() && snapshot.data().totalVotes === expectedTotal) {
        clearTimeout(timer);
        unsubscribe();
        resolve(snapshot.data());
      }
    }, error => {
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    });
  });
}

try {
  await signInAnonymously(auth);

  const creation = await createPoll({
    question: "What's your favorite game?",
    options: ["Minecraft", "Valorant", "Fortnite"]
  });
  const poll = creation.data.poll;
  assert.match(poll.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  assert.equal(poll.status, "open");
  assert.equal(poll.totalVotes, 0);
  assert.deepEqual(poll.options.map(option => option.votes), [0, 0, 0]);

  const pollRef = doc(db, "polls", poll.code);
  const voteRef = doc(db, "polls", poll.code, "votes", auth.currentUser.uid);

  // Public individual reads remain available for the View Poll and Results screens.
  const publicPoll = await getDoc(pollRef);
  assert.equal(publicPoll.data().question, "What's your favorite game?");

  // Enumeration and every direct client write must be rejected by Firestore Rules.
  await expectError(() => getDocs(collection(db, "polls")), "permission-denied");
  await expectError(() => updateDoc(pollRef, { question: "Manipulated question" }), "permission-denied");
  await expectError(() => updateDoc(pollRef, { totalVotes: 999 }), "permission-denied");
  await expectError(() => updateDoc(pollRef, { options: [{ ...poll.options[0], votes: 999 }] }), "permission-denied");
  await expectError(() => setDoc(voteRef, { optionId: poll.options[0].id }), "permission-denied");
  await expectError(() => getDoc(voteRef), "permission-denied");

  // The callable writes the vote and counters atomically; the listener sees the result.
  const realtimeResult = waitForTotal(pollRef, 1);
  await castVote({ code: poll.code, optionId: poll.options[1].id });
  const updatedPoll = await realtimeResult;
  assert.equal(updatedPoll.options[1].votes, 1);

  // The same anonymous UID cannot vote a second time.
  await expectError(
    () => castVote({ code: poll.code, optionId: poll.options[0].id }),
    "functions/already-exists"
  );

  console.log("Security integration tests passed.");
} finally {
  await deleteApp(app);
}
