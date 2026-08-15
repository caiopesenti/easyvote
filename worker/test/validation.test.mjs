import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/errors.js";
import { validatePollInput, validateVoteInput } from "../src/validation.js";

function assertApiError(operation, code) {
  assert.throws(operation, error => error instanceof ApiError && error.code === code);
}

test("poll input is trimmed and accepts two to ten unique options", () => {
  assert.deepEqual(
    validatePollInput({ question: "  Best game? ", options: [" Minecraft ", "Valorant"] }),
    { question: "Best game?", optionTexts: ["Minecraft", "Valorant"] }
  );
});

test("poll input rejects empty, duplicate and privileged fields", () => {
  assertApiError(() => validatePollInput({ question: "", options: ["A", "B"] }), "invalid-argument");
  assertApiError(() => validatePollInput({ question: "Pick", options: ["Same", " same "] }), "invalid-argument");
  assertApiError(
    () => validatePollInput({ question: "Pick", options: ["A", "B"], totalVotes: 999 }),
    "invalid-argument"
  );
});

test("vote input accepts only code and optionId", () => {
  assert.deepEqual(validateVoteInput({ code: "abc23", optionId: "option-1" }), {
    code: "ABC23",
    optionId: "option-1"
  });
  assertApiError(() => validateVoteInput({ code: "ABC23", optionId: "one", totalVotes: 999 }), "invalid-argument");
  assertApiError(() => validateVoteInput({ code: "BAD!", optionId: "one" }), "invalid-argument");
});
