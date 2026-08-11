import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { db, getCurrentUser } from "./firebase.js";

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const CODE_LENGTH = 5;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const HOME_INTRO_STORAGE_KEY = "easyvote-home-intro-played";
const THEME_STORAGE_KEY = "easyvote-theme";

let activePoll = null;
let currentView = "home";
let pollUnsubscribe = null;
let createDraft = { question: "", options: ["", ""] };
let selectedOptionId = null;
let hasUnsavedDraft = false;
let hasPlayedHomeIntro = (() => {
  try {
    return sessionStorage.getItem(HOME_INTRO_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
})();

function getSavedTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme, persist = true) {
  const activeTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = activeTheme;

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, activeTheme);
    } catch {
      // The selected theme remains active until the page is closed.
    }
  }

  const toggle = document.querySelector("[data-action='toggle-theme']");
  if (toggle) {
    const isDark = activeTheme === "dark";
    toggle.setAttribute("aria-pressed", String(isDark));
    toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    toggle.setAttribute("title", isDark ? "Switch to light mode" : "Switch to dark mode");
  }
}

applyTheme(getSavedTheme(), false);

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pollUrl(code) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("poll", code);
  return url.toString();
}

function showToast(message, type = "success") {
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function markHomeIntroPlayed() {
  hasPlayedHomeIntro = true;
  try {
    sessionStorage.setItem(HOME_INTRO_STORAGE_KEY, "true");
  } catch {
    // The in-memory flag still prevents a repeat while the page remains open.
  }
}

function playHomeSlogan() {
  const text = "Create. Share. Decide.";
  const typedText = document.querySelector("#home-slogan-text");
  const cursor = document.querySelector("#home-slogan-cursor");
  if (!typedText || !cursor) return;

  let characterIndex = 0;
  const typeNextCharacter = () => {
    if (!document.contains(typedText)) return;
    if (characterIndex >= text.length) {
      cursor.classList.add("is-fading");
      return;
    }

    typedText.textContent += text[characterIndex];
    characterIndex += 1;
    const pauseAfterWord = characterIndex === 7 || characterIndex === 14;
    window.setTimeout(typeNextCharacter, pauseAfterWord ? 260 : 48);
  };

  typeNextCharacter();
}

function logo() {
  return `<button class="brand" type="button" data-action="home" aria-label="EasyVote home">EasyVote</button>`;
}

function themeToggle() {
  const isDark = document.documentElement.dataset.theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return `<button class="theme-toggle" type="button" data-action="toggle-theme" aria-label="${label}" aria-pressed="${isDark}" title="${label}">
    <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.2A8.6 8.6 0 0 1 8.8 3.6a8.8 8.8 0 1 0 11.6 11.6Z" /></svg>
    <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3" /></svg>
  </button>`;
}

function layout(content, modifier = "") {
  app.innerHTML = `<main class="page ${modifier}">
    <header class="site-header">${logo()}${themeToggle()}</header>
    ${content}
  </main>`;
}

function stopPolling() {
  if (pollUnsubscribe) pollUnsubscribe();
  pollUnsubscribe = null;
}

function navigate(view, { poll = null, replaceUrl = true } = {}) {
  stopPolling();
  currentView = view;
  selectedOptionId = null;
  if (poll) activePoll = poll;

  if (replaceUrl) {
    const url = new URL(window.location.href);
    if (view === "poll" || view === "results") url.searchParams.set("poll", activePoll?.code || "");
    else url.search = "";
    window.history.pushState({}, "", url);
  }

  if (view === "home") renderHome();
  if (view === "create") renderCreate();
  if (view === "created") renderCreated();
  if (view === "poll") subscribeToPoll(activePoll?.code, renderPoll);
  if (view === "results") subscribeToPoll(activePoll?.code, renderResults);
}

function renderHome() {
  hasUnsavedDraft = false;
  const respectsReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shouldAnimateSlogan = !hasPlayedHomeIntro && !respectsReducedMotion;
  const slogan = shouldAnimateSlogan
    ? `<span id="home-slogan-text"></span><span id="home-slogan-cursor" class="slogan-cursor" aria-hidden="true"></span>`
    : "Create. Share. Decide.";
  layout(`<section class="hero">
    <p class="eyebrow">Simple, shareable polls</p>
    <h1 aria-label="Create. Share. Decide.">${slogan}</h1>
    <p class="hero-copy">Create beautiful polls in seconds.</p>
    <button class="button button-primary button-large" type="button" data-action="create">Create Poll <span aria-hidden="true">→</span></button>
    <form class="join-form" id="join-form">
      <label for="poll-code">Have a poll code?</label>
      <div class="join-fields">
        <input id="poll-code" name="code" maxlength="${CODE_LENGTH}" autocomplete="off" placeholder="Enter poll code..." aria-label="Poll code" />
        <button class="button button-secondary" type="submit">Join</button>
      </div>
    </form>
  </section>`);

  if (shouldAnimateSlogan) {
    markHomeIntroPlayed();
    playHomeSlogan();
  } else {
    markHomeIntroPlayed();
  }
}

function optionInput(value, index) {
  const deletable = createDraft.options.length > MIN_OPTIONS;
  return `<div class="option-input-row">
    <input class="text-input option-input" data-option-index="${index}" value="${escapeHtml(value)}" maxlength="120" placeholder="Option ${index + 1}" aria-label="Option ${index + 1}" />
    ${deletable ? `<button class="icon-button" type="button" data-action="remove-option" data-option-index="${index}" aria-label="Remove option ${index + 1}">×</button>` : ""}
  </div>`;
}

function renderCreate() {
  layout(`<section class="form-page">
    <div class="page-intro">
      <h1>Create your poll</h1>
      <p>Create a question and add your options.</p>
    </div>
    <form class="poll-form" id="create-poll-form">
      <label class="field-label" for="question">Question</label>
      <input id="question" class="text-input" value="${escapeHtml(createDraft.question)}" maxlength="180" placeholder="What's your question?" required />
      <div class="options-heading"><span class="field-label">Options</span><span class="field-hint">${MIN_OPTIONS}–${MAX_OPTIONS} options</span></div>
      <div id="option-inputs">${createDraft.options.map(optionInput).join("")}</div>
      <button class="text-button" type="button" data-action="add-option" ${createDraft.options.length >= MAX_OPTIONS ? "disabled" : ""}>+ Add option</button>
      <div class="form-footer"><button class="button button-primary" type="submit">Create Poll</button></div>
    </form>
  </section>`);
}

function pollPreview(poll) {
  return `<article class="poll-preview">
    <h2>${escapeHtml(poll.question)}</h2>
    <ul>${poll.options.map(option => `<li><span class="radio-indicator"></span>${escapeHtml(option.text)}</li>`).join("")}</ul>
  </article>`;
}

function renderCreated() {
  if (!activePoll) return navigate("home");
  hasUnsavedDraft = false;
  layout(`<section class="created-page">
    <div class="page-intro"><h1>Poll created! <span aria-hidden="true">🎉</span></h1><p>Your poll is ready to share.</p></div>
    ${pollPreview(activePoll)}
    <div class="share-panel">
      <h2>Share your poll</h2>
      <div class="code-box"><code>${activePoll.code}</code><button class="copy-inline" type="button" data-action="copy-code">Copy</button></div>
      <button class="button button-primary full-button" type="button" data-action="copy-link">Copy link</button>
      <button class="button button-secondary full-button" type="button" data-action="view-poll">View poll</button>
    </div>
  </section>`);
}

function pollCard(poll) {
  return `<article class="vote-card">
    <h1>${escapeHtml(poll.question)}</h1>
    <div class="poll-options">
      ${poll.options.map(option => `<button type="button" class="poll-option ${selectedOptionId === option.id ? "is-selected" : ""}" data-action="select-option" data-option-id="${option.id}" aria-pressed="${selectedOptionId === option.id}"><span class="radio-indicator"></span><span>${escapeHtml(option.text)}</span></button>`).join("")}
    </div>
    <button class="button button-primary vote-button" type="button" data-action="vote" ${selectedOptionId ? "" : "disabled"}>Vote</button>
  </article>`;
}

function renderPoll(poll) {
  activePoll = poll;
  layout(`<section class="poll-page">${pollCard(poll)}</section>`);
}

function resultRows(poll) {
  const total = poll.totalVotes || 0;
  return poll.options.map(option => {
    const percent = total ? Math.round((option.votes / total) * 100) : 0;
    return `<div class="result-row"><div class="result-label"><span>${escapeHtml(option.text)}</span><strong>${percent}%</strong></div><div class="progress-track"><div class="progress-fill" style="--progress:${percent}%"></div></div></div>`;
  }).join("");
}

function renderResults(poll) {
  activePoll = poll;
  layout(`<section class="poll-page"><article class="results-card"><h1>${escapeHtml(poll.question)}</h1><div class="results-list">${resultRows(poll)}</div><p class="vote-count">${poll.totalVotes || 0} ${(poll.totalVotes || 0) === 1 ? "vote" : "votes"}</p></article></section>`);
}

function renderMissingPoll() {
  layout(`<section class="empty-state"><p class="eyebrow">Poll not found</p><h1>We couldn't find that poll.</h1><p>Check the code and try again.</p><button class="button button-primary" type="button" data-action="home">Back home</button></section>`);
}

function subscribeToPoll(code, callback) {
  if (!code) return renderMissingPoll();
  pollUnsubscribe = onSnapshot(doc(db, "polls", code), snapshot => {
    if (!snapshot.exists()) return renderMissingPoll();
    callback(snapshot.data());
  }, error => {
    console.error(error);
    showToast("We couldn't load this poll. Please try again.", "error");
  });
}

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: CODE_LENGTH }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

async function createPoll() {
  const question = createDraft.question.trim();
  const optionTexts = createDraft.options.map(value => value.trim()).filter(Boolean);
  if (!question) throw new Error("Add a question before creating your poll.");
  if (optionTexts.length < MIN_OPTIONS) throw new Error("Add at least two options.");
  if (new Set(optionTexts.map(text => text.toLocaleLowerCase())).size !== optionTexts.length) throw new Error("Each option needs a different name.");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateCode();
    const ref = doc(db, "polls", code);
    if ((await getDoc(ref)).exists()) continue;
    const poll = {
      code,
      question,
      options: optionTexts.map(text => ({ id: crypto.randomUUID(), text, votes: 0 })),
      totalVotes: 0,
      createdAt: serverTimestamp()
    };
    await setDoc(ref, poll);
    return poll;
  }
  throw new Error("We couldn't generate a poll code. Please try again.");
}

async function joinPoll(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw new Error("Enter a poll code first.");
  const snapshot = await getDoc(doc(db, "polls", code));
  if (!snapshot.exists()) throw new Error("We couldn't find a poll with that code.");
  navigate("poll", { poll: snapshot.data() });
}

async function vote() {
  if (!activePoll || !selectedOptionId) return;
  const user = await getCurrentUser();
  const pollRef = doc(db, "polls", activePoll.code);
  const voteRef = doc(db, "polls", activePoll.code, "votes", user.uid);
  const result = await runTransaction(db, async transaction => {
    const existingVote = await transaction.get(voteRef);
    if (existingVote.exists()) return "already-voted";
    const pollSnapshot = await transaction.get(pollRef);
    if (!pollSnapshot.exists()) throw new Error("This poll is no longer available.");
    const poll = pollSnapshot.data();
    const options = poll.options.map(option => option.id === selectedOptionId ? { ...option, votes: option.votes + 1 } : option);
    transaction.update(pollRef, { options, totalVotes: (poll.totalVotes || 0) + 1 });
    transaction.set(voteRef, { optionId: selectedOptionId, createdAt: serverTimestamp() });
    return "voted";
  });
  if (result === "already-voted") showToast("You have already voted in this poll.", "error");
  else showToast("Vote recorded. Thanks!", "success");
  navigate("results", { poll: activePoll });
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    showToast("Copying isn't available here. Select the text manually.", "error");
  }
}

function confirmLeaveDraft() {
  if (!hasUnsavedDraft) return true;
  return window.confirm("Leave this poll? Your unfinished changes will be lost.");
}

document.addEventListener("input", event => {
  if (event.target.id === "question") {
    createDraft.question = event.target.value;
    hasUnsavedDraft = Boolean(createDraft.question.trim() || createDraft.options.some(Boolean));
  }
  if (event.target.matches(".option-input")) {
    createDraft.options[Number(event.target.dataset.optionIndex)] = event.target.value;
    hasUnsavedDraft = Boolean(createDraft.question.trim() || createDraft.options.some(Boolean));
  }
  if (event.target.id === "poll-code") event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    if (event.target.id === "join-form") await joinPoll(new FormData(event.target).get("code"));
    if (event.target.id === "create-poll-form") {
      const button = event.target.querySelector('[type="submit"]');
      button.disabled = true;
      button.textContent = "Creating…";
      const poll = await createPoll();
      createDraft = { question: "", options: ["", ""] };
      navigate("created", { poll });
    }
  } catch (error) {
    showToast(error.message || "Something went wrong. Please try again.", "error");
    const button = event.target.querySelector('[type="submit"]');
    if (button) { button.disabled = false; button.textContent = event.target.id === "create-poll-form" ? "Create Poll" : "Join"; }
  }
});

document.addEventListener("click", async event => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action } = target.dataset;
  try {
    if (action === "toggle-theme") applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    if (action === "home") { if (confirmLeaveDraft()) navigate("home"); }
    if (action === "create") navigate("create");
    if (action === "add-option" && createDraft.options.length < MAX_OPTIONS) { createDraft.options.push(""); renderCreate(); }
    if (action === "remove-option") { createDraft.options.splice(Number(target.dataset.optionIndex), 1); renderCreate(); }
    if (action === "view-poll") navigate("poll", { poll: activePoll });
    if (action === "select-option") { selectedOptionId = target.dataset.optionId; renderPoll(activePoll); }
    if (action === "vote") await vote();
    if (action === "copy-code") await copyText(activePoll.code, "Poll code copied.");
    if (action === "copy-link") await copyText(pollUrl(activePoll.code), "Poll link copied.");
  } catch (error) {
    showToast(error.message || "Something went wrong. Please try again.", "error");
  }
});

window.addEventListener("popstate", () => {
  const code = new URLSearchParams(window.location.search).get("poll");
  if (code) navigate("poll", { poll: { code }, replaceUrl: false });
  else navigate("home", { replaceUrl: false });
});

const initialCode = new URLSearchParams(window.location.search).get("poll");
if (initialCode) navigate("poll", { poll: { code: initialCode }, replaceUrl: false });
else navigate("home", { replaceUrl: false });
