import { verifyFirebaseIdentity, verifyFirebaseToken } from "./auth.js";
import { ApiError, FirestoreError } from "./errors.js";
import {
  batchGetDocuments,
  beginTransaction,
  commitVote,
  createPollDocument,
  queryPollsByOwner,
  recordMergedAnonymousUid,
  transferPollOwnership,
  rollbackTransaction
} from "./firestore.js";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  validateAccountMergeInput,
  validateEmptyInput,
  validatePollInput,
  validateVoteInput
} from "./validation.js";

const MAX_BODY_LENGTH = 16_384;
const MAX_CODE_ATTEMPTS = 8;
const MAX_TRANSACTION_ATTEMPTS = 5;
const MAX_MERGED_IDENTITIES = 100;

function generatePollCode() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(randomBytes, byte => CODE_ALPHABET[byte & 31]).join("");
}

function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_LENGTH) throw new ApiError("invalid-argument", "Invalid request.", 413);

  const rawBody = await request.text();
  if (!rawBody || rawBody.length > MAX_BODY_LENGTH) throw new ApiError("invalid-argument", "Invalid request.");
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new ApiError("invalid-argument", "Invalid request.");
  }
}

async function createPoll(ownerUid, data, env) {
  const { question, optionTexts } = validatePollInput(data);
  const options = optionTexts.map(text => ({ id: crypto.randomUUID(), text, votes: 0 }));

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generatePollCode();
    const storedPoll = {
      ownerUid,
      code,
      question,
      options,
      totalVotes: 0,
      status: "open"
    };

    try {
      await createPollDocument(env, storedPoll);
      return {
        poll: { code, question, options, totalVotes: 0, status: "open" }
      };
    } catch (error) {
      if (error instanceof FirestoreError && error.firestoreStatus === "ALREADY_EXISTS") continue;
      throw error;
    }
  }

  throw new ApiError("internal", "Unable to create the poll.", 500);
}

async function castVote(voterIdentity, data, env) {
  const voterUid = voterIdentity.sub;
  const { code, optionId } = validateVoteInput(data);
  const pollPath = `polls/${code}`;
  const accountPath = `accounts/${voterUid}`;

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const transaction = await beginTransaction(env);
    try {
      const [pollDocument, accountDocument] = await batchGetDocuments(
        env,
        [pollPath, accountPath],
        transaction
      );

      if (!pollDocument) throw new ApiError("not-found", "Poll not found.", 404);

      const mergedAnonymousUids = accountDocument?.data?.mergedAnonymousUids || [];
      if (!Array.isArray(mergedAnonymousUids)
        || mergedAnonymousUids.length > MAX_MERGED_IDENTITIES
        || mergedAnonymousUids.some(uid => typeof uid !== "string" || !uid || uid.length > 128)) {
        throw new ApiError("internal", "Invalid account data.", 500);
      }
      const votingUids = [...new Set([voterUid, ...mergedAnonymousUids])];
      const votePaths = votingUids.map(uid => `${pollPath}/votes/${uid}`);
      const voteDocuments = await batchGetDocuments(env, votePaths, transaction);
      if (voteDocuments.some(Boolean)) {
        throw new ApiError("already-voted", "Vote already recorded.", 409);
      }

      const poll = pollDocument.data;
      if (poll.status !== "open") throw new ApiError("failed-precondition", "Poll is closed.", 409);
      if (!Array.isArray(poll.options) || !Number.isSafeInteger(poll.totalVotes) || poll.totalVotes < 0) {
        throw new ApiError("internal", "Invalid poll data.", 500);
      }

      const optionIndex = poll.options.findIndex(option => option?.id === optionId);
      if (optionIndex === -1 || !Number.isSafeInteger(poll.options[optionIndex].votes) || poll.options[optionIndex].votes < 0) {
        throw new ApiError("invalid-argument", "Invalid poll option.");
      }
      if (!Number.isSafeInteger(poll.totalVotes + 1)) {
        throw new ApiError("internal", "Invalid poll data.", 500);
      }

      const options = poll.options.map((option, index) => (
        index === optionIndex ? { ...option, votes: option.votes + 1 } : option
      ));

      await commitVote(env, {
        transaction,
        pollPath,
        votePath: `${pollPath}/votes/${voterUid}`,
        options,
        totalVotes: poll.totalVotes + 1,
        optionId
      });
      return { success: true };
    } catch (error) {
      await rollbackTransaction(env, transaction);

      if (error instanceof ApiError) throw error;
      if (error instanceof FirestoreError && error.firestoreStatus === "ALREADY_EXISTS") {
        throw new ApiError("already-voted", "Vote already recorded.", 409);
      }
      if (error instanceof FirestoreError && ["ABORTED", "FAILED_PRECONDITION"].includes(error.firestoreStatus)) {
        continue;
      }
      throw error;
    }
  }

  throw new ApiError("unavailable", "Please try again.", 503);
}

async function listMyPolls(ownerUid, data, env) {
  validateEmptyInput(data);
  const documents = await queryPollsByOwner(env, ownerUid, 100);
  const polls = documents
    .map(document => document.data)
    .filter(poll => typeof poll?.code === "string" && typeof poll?.question === "string")
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
    .map(poll => ({
      code: poll.code,
      question: poll.question,
      options: Array.isArray(poll.options) ? poll.options : [],
      totalVotes: Number.isSafeInteger(poll.totalVotes) ? poll.totalVotes : 0,
      status: poll.status === "open" ? "open" : "closed",
      createdAt: poll.createdAt || null
    }));
  return { polls };
}

function isAnonymousIdentity(identity) {
  return identity?.firebase?.sign_in_provider === "anonymous";
}

function isGoogleIdentity(identity) {
  return identity?.firebase?.sign_in_provider === "google.com";
}

async function mergeAnonymousAccount(sourceIdentity, data, request, env) {
  const { targetIdToken } = validateAccountMergeInput(data);
  if (!isAnonymousIdentity(sourceIdentity)) {
    throw new ApiError("failed-precondition", "Account merge is not available.", 409);
  }

  const targetIdentity = await verifyFirebaseToken(targetIdToken, request, env);
  if (!isGoogleIdentity(targetIdentity)) {
    throw new ApiError("invalid-argument", "A Google account is required.");
  }
  if (sourceIdentity.sub === targetIdentity.sub) return { success: true, transferredPolls: 0 };

  await recordMergedAnonymousUid(env, targetIdentity.sub, sourceIdentity.sub);
  const transferredPolls = await transferPollOwnership(env, sourceIdentity.sub, targetIdentity.sub);
  return { success: true, transferredPolls };
}

async function handleRequest(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!allowedOrigins(env).has(origin)) {
    return new Response("Origin not allowed.", { status: 403 });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: { code: "method-not-allowed", message: "Method not allowed." } }, 405, origin);
  }

  try {
    const identity = await verifyFirebaseIdentity(request, env);
    const data = await readJsonBody(request);
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "");

    if (pathname === "/createPoll") return jsonResponse(await createPoll(identity.sub, data, env), 200, origin);
    if (pathname === "/castVote") return jsonResponse(await castVote(identity, data, env), 200, origin);
    if (pathname === "/listMyPolls") return jsonResponse(await listMyPolls(identity.sub, data, env), 200, origin);
    if (pathname === "/mergeAnonymousAccount") {
      return jsonResponse(await mergeAnonymousAccount(identity, data, request, env), 200, origin);
    }
    throw new ApiError("not-found", "Endpoint not found.", 404);
  } catch (error) {
    if (error instanceof ApiError) {
      const publicMessage = error.status >= 500 ? "The request could not be completed." : error.message;
      return jsonResponse({ error: { code: error.code, message: publicMessage } }, error.status, origin);
    }

    console.error("EasyVote Worker request failed.", error);
    return jsonResponse(
      { error: { code: "unavailable", message: "The request could not be completed." } },
      503,
      origin
    );
  }
}

export default { fetch: handleRequest };
