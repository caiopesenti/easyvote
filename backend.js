import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-functions.js";
import { functions, getCurrentUser } from "./firebase.js";

// Production uses the published Worker. Local development keeps using the
// dedicated local Worker and Firebase Emulators configured below/in firebase.js.
const PRODUCTION_WORKER_URL = "https://easyvote-api.easyvote-dev.workers.dev";
const LOCAL_WORKER_URL = "http://127.0.0.1:8787";
const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const workerBaseUrl = isLocalDevelopment ? LOCAL_WORKER_URL : PRODUCTION_WORKER_URL;

const createPollCallable = httpsCallable(functions, "createPoll");
const castVoteCallable = httpsCallable(functions, "castVote");

async function callWorker(operation, payload) {
  const user = await getCurrentUser();
  const idToken = await user.getIdToken();

  let response;
  try {
    response = await fetch(`${workerBaseUrl}/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch {
    throw Object.assign(new Error("The EasyVote API is unavailable."), { code: "unavailable" });
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error?.code || "unavailable";
    throw Object.assign(new Error(body?.error?.message || "The request could not be completed."), { code });
  }

  return body;
}

async function createPollSecure(payload) {
  if (workerBaseUrl) return callWorker("createPoll", payload);

  await getCurrentUser();
  const response = await createPollCallable(payload);
  return response.data;
}

async function castVoteSecure(payload) {
  if (workerBaseUrl) return callWorker("castVote", payload);

  await getCurrentUser();
  const response = await castVoteCallable(payload);
  return response.data;
}

export { castVoteSecure, createPollSecure };
