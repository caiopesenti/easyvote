import { ApiError } from "./errors.js";

const CODE_LENGTH = 5;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_QUESTION_LENGTH = 180;
const MAX_OPTION_LENGTH = 120;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

function asTrimmedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertOnlyKeys(data, allowedKeys) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ApiError("invalid-argument", "Invalid request.");
  }
  if (Object.keys(data).some(key => !allowedKeys.includes(key))) {
    throw new ApiError("invalid-argument", "Invalid request.");
  }
}

function validatePollInput(data) {
  assertOnlyKeys(data, ["question", "options"]);

  const question = asTrimmedText(data.question);
  if (!question || question.length > MAX_QUESTION_LENGTH) {
    throw new ApiError("invalid-argument", "A valid question is required.");
  }

  if (!Array.isArray(data.options) || data.options.length < MIN_OPTIONS || data.options.length > MAX_OPTIONS) {
    throw new ApiError("invalid-argument", "A poll must have between two and ten options.");
  }

  const optionTexts = data.options.map(asTrimmedText);
  if (optionTexts.some(text => !text || text.length > MAX_OPTION_LENGTH)) {
    throw new ApiError("invalid-argument", "Each option must contain valid text.");
  }

  const normalizedOptions = optionTexts.map(text => text.toLocaleLowerCase());
  if (new Set(normalizedOptions).size !== optionTexts.length) {
    throw new ApiError("invalid-argument", "Poll options must be unique.");
  }

  return { question, optionTexts };
}

function validateVoteInput(data) {
  assertOnlyKeys(data, ["code", "optionId"]);
  const code = asTrimmedText(data.code).toUpperCase();
  const optionId = asTrimmedText(data.optionId);

  if (!CODE_PATTERN.test(code) || !optionId || optionId.length > 100) {
    throw new ApiError("invalid-argument", "Invalid vote request.");
  }

  return { code, optionId };
}

function validateEmptyInput(data) {
  assertOnlyKeys(data, []);
  return {};
}

function validateAccountMergeInput(data) {
  assertOnlyKeys(data, ["targetIdToken"]);
  const targetIdToken = asTrimmedText(data.targetIdToken);
  if (!targetIdToken || targetIdToken.length > 8_192) {
    throw new ApiError("invalid-argument", "Invalid account merge request.");
  }
  return { targetIdToken };
}

export {
  CODE_ALPHABET,
  CODE_LENGTH,
  validateAccountMergeInput,
  validateEmptyInput,
  validatePollInput,
  validateVoteInput
};
