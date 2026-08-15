import { importPKCS8, SignJWT } from "jose";
import { FirestoreError } from "./errors.js";

const DATASTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedAccessToken = null;

function isEmulatorMode(env) {
  return env.ENVIRONMENT === "development"
    && env.FIREBASE_EMULATOR_MODE === "true"
    && Boolean(env.FIRESTORE_EMULATOR_HOST);
}

function databaseName(env) {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)`;
}

function documentName(env, path) {
  return `${databaseName(env)}/documents/${path}`;
}

function firestoreBaseUrl(env) {
  if (isEmulatorMode(env)) return `http://${env.FIRESTORE_EMULATOR_HOST}/v1/${databaseName(env)}`;
  return `https://firestore.googleapis.com/v1/${databaseName(env)}`;
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return { integerValue: String(value) };
    if (Number.isFinite(value)) return { doubleValue: value };
    throw new TypeError("Firestore cannot encode a non-finite number.");
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === "object") return { mapValue: { fields: encodeFields(value) } };
  throw new TypeError("Unsupported Firestore value.");
}

function encodeFields(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)])
  );
}

function decodeValue(value = {}) {
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return undefined;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

async function getServiceAccountAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken?.expiresAt > now + 60) return cachedAccessToken.value;

  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new FirestoreError(500, "MISSING_CREDENTIALS", "Firestore credentials are not configured.");
  }

  const privateKey = env.FIREBASE_PRIVATE_KEY.replaceAll("\\n", "\n");
  const signingKey = await importPKCS8(privateKey, "RS256");
  const assertion = await new SignJWT({ scope: DATASTORE_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(env.FIREBASE_CLIENT_EMAIL)
    .setSubject(env.FIREBASE_CLIENT_EMAIL)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    throw new FirestoreError(response.status, body?.error || "OAUTH_ERROR", "Unable to authorize Firestore access.");
  }

  cachedAccessToken = {
    value: body.access_token,
    expiresAt: now + Number(body.expires_in || 3600)
  };
  return cachedAccessToken.value;
}

async function firestoreRequest(env, path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // The Firestore emulator recognizes this reserved local owner token as the
  // Admin SDK equivalent. The production branch can only use Google OAuth.
  if (isEmulatorMode(env)) headers.Authorization = "Bearer owner";
  else headers.Authorization = `Bearer ${await getServiceAccountAccessToken(env)}`;

  const response = await fetch(`${firestoreBaseUrl(env)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    throw new FirestoreError(
      response.status,
      responseBody?.error?.status || "UNKNOWN",
      responseBody?.error?.message || "Firestore request failed."
    );
  }
  return responseBody;
}

async function createPollDocument(env, poll) {
  const name = documentName(env, `polls/${poll.code}`);
  return firestoreRequest(env, "/documents:commit", {
    method: "POST",
    body: {
      writes: [{
        update: {
          name,
          fields: encodeFields(poll)
        },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
      }]
    }
  });
}

async function beginTransaction(env) {
  const response = await firestoreRequest(env, "/documents:beginTransaction", {
    method: "POST",
    body: { options: { readWrite: {} } }
  });
  return response.transaction;
}

async function getDocument(env, path, transaction) {
  const query = transaction ? `?transaction=${encodeURIComponent(transaction)}` : "";
  try {
    const document = await firestoreRequest(env, `/documents/${path}${query}`);
    return {
      name: document.name,
      updateTime: document.updateTime,
      data: decodeFields(document.fields || {})
    };
  } catch (error) {
    if (error instanceof FirestoreError && error.status === 404) return null;
    throw error;
  }
}

async function batchGetDocuments(env, paths, transaction) {
  const names = paths.map(path => documentName(env, path));
  const response = await firestoreRequest(env, "/documents:batchGet", {
    method: "POST",
    body: { documents: names, transaction }
  });
  const rows = Array.isArray(response) ? response : [response];

  return names.map(name => {
    const row = rows.find(item => item?.found?.name === name || item?.missing === name);
    if (!row?.found) return null;
    return {
      name: row.found.name,
      updateTime: row.found.updateTime,
      data: decodeFields(row.found.fields || {})
    };
  });
}

async function commitVote(env, { transaction, pollPath, votePath, options, totalVotes, optionId }) {
  return firestoreRequest(env, "/documents:commit", {
    method: "POST",
    body: {
      transaction,
      writes: [
        {
          update: {
            name: documentName(env, votePath),
            fields: encodeFields({ optionId })
          },
          currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]
        },
        {
          update: {
            name: documentName(env, pollPath),
            fields: encodeFields({ options, totalVotes })
          },
          updateMask: { fieldPaths: ["options", "totalVotes"] }
        }
      ]
    }
  });
}

async function rollbackTransaction(env, transaction) {
  if (!transaction) return;
  await firestoreRequest(env, "/documents:rollback", {
    method: "POST",
    body: { transaction }
  }).catch(() => undefined);
}

export {
  beginTransaction,
  batchGetDocuments,
  commitVote,
  createPollDocument,
  FirestoreError,
  getDocument,
  rollbackTransaction
};
