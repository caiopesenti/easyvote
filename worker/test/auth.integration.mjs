import assert from "node:assert/strict";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  linkWithCredential,
  signInAnonymously,
  signInWithCredential,
  signOut
} from "firebase/auth";

const projectId = "enquete-ia-sabe-codar";
const config = {
  apiKey: "auth-integration-test-key",
  appId: "auth-integration-test-app",
  projectId
};
const apps = [];

function createTestAuth(label) {
  const app = initializeApp(config, `${label}-${Date.now()}-${crypto.randomUUID()}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  return auth;
}

function googleCredential(subject, email) {
  return GoogleAuthProvider.credential(JSON.stringify({
    sub: subject,
    email,
    email_verified: true,
    name: "EasyVote Auth Test"
  }));
}

try {
  const linkingAuth = createTestAuth("linking");
  const guest = await signInAnonymously(linkingAuth);
  const guestUid = guest.user.uid;
  const freshGoogle = googleCredential(
    `fresh-google-${crypto.randomUUID()}`,
    `fresh-${crypto.randomUUID()}@example.test`
  );
  const linked = await linkWithCredential(guest.user, freshGoogle);
  assert.equal(linked.user.uid, guestUid);
  assert.equal(linked.user.isAnonymous, false);
  assert.equal(linked.user.providerData.some(provider => provider.providerId === "google.com"), true);

  await signOut(linkingAuth);
  const restoredGoogle = await signInWithCredential(linkingAuth, freshGoogle);
  assert.equal(restoredGoogle.user.uid, guestUid);
  await signOut(linkingAuth);
  const nextGuest = await signInAnonymously(linkingAuth);
  assert.notEqual(nextGuest.user.uid, guestUid);

  const existingAuth = createTestAuth("existing-google");
  const conflictAuth = createTestAuth("conflicting-guest");
  const existingGoogle = googleCredential(
    `existing-google-${crypto.randomUUID()}`,
    `existing-${crypto.randomUUID()}@example.test`
  );
  const existing = await signInWithCredential(existingAuth, existingGoogle);
  const conflictingGuest = await signInAnonymously(conflictAuth);
  const conflictingGuestUid = conflictingGuest.user.uid;

  await assert.rejects(
    () => linkWithCredential(conflictingGuest.user, existingGoogle),
    error => error?.code === "auth/credential-already-in-use"
  );
  assert.equal(conflictAuth.currentUser.uid, conflictingGuestUid);
  assert.equal(conflictAuth.currentUser.isAnonymous, true);

  const isolatedTargetAuth = createTestAuth("isolated-target");
  const isolatedTarget = await signInWithCredential(isolatedTargetAuth, existingGoogle);
  assert.equal(isolatedTarget.user.uid, existing.user.uid);
  assert.equal(conflictAuth.currentUser.uid, conflictingGuestUid);

  console.log("Firebase Auth linking and conflict integration tests passed.");
} finally {
  await Promise.all(apps.map(app => deleteApp(app)));
}
