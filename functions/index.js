const { randomInt, randomUUID } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

initializeApp();

const db = getFirestore();
const REGION = "southamerica-east1";
const CODE_LENGTH = 5;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_QUESTION_LENGTH = 180;
const MAX_OPTION_LENGTH = 120;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function requireAuthenticatedUser(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
  return request.auth.uid;
}

function asTrimmedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertOnlyKeys(data, allowedKeys) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Invalid request.");
  }
  if (Object.keys(data).some(key => !allowedKeys.includes(key))) {
    throw new HttpsError("invalid-argument", "Invalid request.");
  }
}

function validatePollInput(data) {
  assertOnlyKeys(data, ["question", "options"]);

  const question = asTrimmedText(data.question);
  if (!question || question.length > MAX_QUESTION_LENGTH) {
    throw new HttpsError("invalid-argument", "A valid question is required.");
  }

  if (!Array.isArray(data.options) || data.options.length < MIN_OPTIONS || data.options.length > MAX_OPTIONS) {
    throw new HttpsError("invalid-argument", "A poll must have between two and ten options.");
  }

  const optionTexts = data.options.map(asTrimmedText);
  if (optionTexts.some(text => !text || text.length > MAX_OPTION_LENGTH)) {
    throw new HttpsError("invalid-argument", "Each option must contain valid text.");
  }

  const normalizedOptions = optionTexts.map(text => text.toLocaleLowerCase());
  if (new Set(normalizedOptions).size !== optionTexts.length) {
    throw new HttpsError("invalid-argument", "Poll options must be unique.");
  }

  return { question, optionTexts };
}

function validateVoteInput(data) {
  assertOnlyKeys(data, ["code", "optionId"]);
  const code = asTrimmedText(data.code).toUpperCase();
  const optionId = asTrimmedText(data.optionId);

  if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code) || !optionId || optionId.length > 100) {
    throw new HttpsError("invalid-argument", "Invalid vote request.");
  }

  return { code, optionId };
}

function generatePollCode() {
  return Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  ).join("");
}

exports.createPoll = onCall({ region: REGION }, async request => {
  const ownerUid = requireAuthenticatedUser(request);
  const { question, optionTexts } = validatePollInput(request.data);
  const options = optionTexts.map(text => ({ id: randomUUID(), text, votes: 0 }));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generatePollCode();
    const pollRef = db.doc(`polls/${code}`);
    const created = await db.runTransaction(async transaction => {
      if ((await transaction.get(pollRef)).exists) return false;

      transaction.create(pollRef, {
        ownerUid,
        code,
        question,
        options,
        totalVotes: 0,
        status: "open",
        createdAt: FieldValue.serverTimestamp()
      });
      return true;
    });

    if (created) {
      return {
        poll: {
          code,
          question,
          options,
          totalVotes: 0,
          status: "open"
        }
      };
    }
  }

  throw new HttpsError("internal", "Unable to create the poll.");
});

exports.castVote = onCall({ region: REGION }, async request => {
  const voterUid = requireAuthenticatedUser(request);
  const { code, optionId } = validateVoteInput(request.data);
  const pollRef = db.doc(`polls/${code}`);
  const voteRef = pollRef.collection("votes").doc(voterUid);

  await db.runTransaction(async transaction => {
    const [pollSnapshot, voteSnapshot] = await Promise.all([
      transaction.get(pollRef),
      transaction.get(voteRef)
    ]);

    if (!pollSnapshot.exists) {
      throw new HttpsError("not-found", "Poll not found.");
    }
    if (voteSnapshot.exists) {
      throw new HttpsError("already-exists", "Vote already recorded.");
    }

    const poll = pollSnapshot.data();
    if (poll.status !== "open") {
      throw new HttpsError("failed-precondition", "Poll is closed.");
    }
    if (!Array.isArray(poll.options) || !Number.isSafeInteger(poll.totalVotes) || poll.totalVotes < 0) {
      throw new HttpsError("internal", "Invalid poll data.");
    }

    const optionIndex = poll.options.findIndex(option => option?.id === optionId);
    if (optionIndex === -1 || !Number.isSafeInteger(poll.options[optionIndex].votes) || poll.options[optionIndex].votes < 0) {
      throw new HttpsError("invalid-argument", "Invalid poll option.");
    }

    const options = poll.options.map((option, index) => (
      index === optionIndex ? { ...option, votes: option.votes + 1 } : option
    ));

    transaction.create(voteRef, {
      optionId,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.update(pollRef, {
      options,
      totalVotes: poll.totalVotes + 1
    });
  });

  return { success: true };
});
