import assert from "node:assert/strict";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInAnonymously } from "firebase/auth";
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
import worker from "../src/index.js";

const projectId = "enquete-ia-sabe-codar";
const allowedOrigin = "http://127.0.0.1:5000";
const workerBaseUrl = process.env.EASYVOTE_WORKER_URL || "";
const workerEnv = {
  ENVIRONMENT: "development",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_EMULATOR_MODE: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  ALLOWED_ORIGINS: "http://127.0.0.1:5000,http://localhost:5000"
};

const app = initializeApp({
  apiKey: "worker-security-test-key",
  appId: "worker-security-test-app",
  projectId
}, `worker-security-integration-${Date.now()}`);
const auth = getAuth(app);
const db = getFirestore(app);

connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);

async function callWorker(operation, data, { token, origin = allowedOrigin } = {}) {
  const headers = { Origin: origin, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`${workerBaseUrl || "http://127.0.0.1:8787"}/${operation}`, {
    method: "POST",
    headers,
    body: JSON.stringify(data)
  });
  const response = workerBaseUrl ? await fetch(request) : await worker.fetch(request, workerEnv);
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function expectWorkerError(operation, expectedCode, expectedStatus) {
  const { response, body } = await operation();
  assert.equal(response.status, expectedStatus);
  assert.equal(body?.error?.code, expectedCode);
}

async function expectFirebaseError(operation, expectedCode) {
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
  await expectWorkerError(
    () => callWorker("createPoll", { question: "Pick one", options: ["A", "B"] }),
    "unauthenticated",
    401
  );

  const deniedOrigin = await callWorker(
    "createPoll",
    { question: "Pick one", options: ["A", "B"] },
    { origin: "https://not-easyvote.example" }
  );
  assert.equal(deniedOrigin.response.status, 403);

  await signInAnonymously(auth);
  const idToken = await auth.currentUser.getIdToken();

  await expectWorkerError(
    () => callWorker(
      "createPoll",
      { question: "Manipulated", options: ["A", "B"], totalVotes: 999 },
      { token: idToken }
    ),
    "invalid-argument",
    400
  );
  await expectWorkerError(
    () => callWorker("createPoll", { question: "Duplicates", options: ["Same", " same "] }, { token: idToken }),
    "invalid-argument",
    400
  );

  const creation = await callWorker(
    "createPoll",
    { question: "What's your favorite game?", options: ["Minecraft", "Valorant", "Fortnite"] },
    { token: idToken }
  );
  assert.equal(creation.response.status, 200);
  const poll = creation.body.poll;
  assert.match(poll.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  assert.equal(poll.status, "open");
  assert.equal(poll.totalVotes, 0);
  assert.deepEqual(poll.options.map(option => option.votes), [0, 0, 0]);

  const pollRef = doc(db, "polls", poll.code);
  const voteRef = doc(db, "polls", poll.code, "votes", auth.currentUser.uid);

  const publicPoll = await getDoc(pollRef);
  assert.equal(publicPoll.data().question, "What's your favorite game?");
  assert.equal(publicPoll.data().ownerUid, auth.currentUser.uid);

  await expectFirebaseError(() => getDocs(collection(db, "polls")), "permission-denied");
  await expectFirebaseError(() => updateDoc(pollRef, { question: "Manipulated question" }), "permission-denied");
  await expectFirebaseError(() => updateDoc(pollRef, { totalVotes: 999 }), "permission-denied");
  await expectFirebaseError(
    () => updateDoc(pollRef, { options: [{ ...poll.options[0], votes: 999 }] }),
    "permission-denied"
  );
  await expectFirebaseError(() => setDoc(voteRef, { optionId: poll.options[0].id }), "permission-denied");
  await expectFirebaseError(() => getDoc(voteRef), "permission-denied");
  await expectFirebaseError(
    () => getDocs(collection(db, "polls", poll.code, "votes")),
    "permission-denied"
  );

  await expectWorkerError(
    () => callWorker("castVote", { code: poll.code, optionId: "not-an-option" }, { token: idToken }),
    "invalid-argument",
    400
  );
  await expectWorkerError(
    () => callWorker(
      "castVote",
      { code: poll.code, optionId: poll.options[0].id, totalVotes: 999 },
      { token: idToken }
    ),
    "invalid-argument",
    400
  );

  const realtimeResult = waitForTotal(pollRef, 1);
  const vote = await callWorker(
    "castVote",
    { code: poll.code, optionId: poll.options[1].id },
    { token: idToken }
  );
  assert.equal(vote.response.status, 200);
  assert.equal(vote.body.success, true);
  const updatedPoll = await realtimeResult;
  assert.equal(updatedPoll.totalVotes, 1);
  assert.equal(updatedPoll.options[1].votes, 1);

  await expectWorkerError(
    () => callWorker("castVote", { code: poll.code, optionId: poll.options[0].id }, { token: idToken }),
    "already-voted",
    409
  );

  const afterDuplicate = await getDoc(pollRef);
  assert.equal(afterDuplicate.data().totalVotes, 1);
  assert.equal(afterDuplicate.data().options[0].votes, 0);
  assert.equal(afterDuplicate.data().options[1].votes, 1);

  console.log("Cloudflare Worker security integration tests passed.");
} finally {
  await deleteApp(app);
}
