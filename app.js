import {
  doc,
  getDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import {
  castVoteSecure,
  createPollSecure,
  listMyPollsSecure,
  mergeAnonymousAccountSecure
} from "./backend.js";
import {
  db,
  getAuthUser,
  isRegisteredUser,
  signInWithGoogle,
  signOutToGuest,
  subscribeToAuthState
} from "./firebase.js";

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const CODE_LENGTH = 5;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const HOME_INTRO_STORAGE_KEY = "easyvote-home-intro-played";
const THEME_STORAGE_KEY = "easyvote-theme";
const MOBILE_NAVBAR_MEDIA = window.matchMedia("(max-width: 600px)");
const MOBILE_NAVBAR_TOP_LIMIT = 8;
const MOBILE_NAVBAR_SCROLL_THRESHOLD = 24;

let activePoll = null;
let currentView = "home";
let pollUnsubscribe = null;
let createDraft = { question: "", options: ["", ""] };
let selectedOptionId = null;
let hasUnsavedDraft = false;
let shouldAnimateNextView = false;
let accountMenuOpen = false;
let myPollsRequestId = 0;
let signInInProgress = false;
let mobileNavbarLastScrollY = Math.max(window.scrollY, 0);
let mobileNavbarDirection = null;
let mobileNavbarScrollDistance = 0;
let mobileNavbarFrame = null;
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

function setMobileNavbarHidden(hidden) {
  const header = document.querySelector(".site-header");
  if (!header) return;
  const shouldHide = hidden && MOBILE_NAVBAR_MEDIA.matches && window.scrollY > MOBILE_NAVBAR_TOP_LIMIT;
  header.classList.toggle("is-scroll-hidden", shouldHide);
}

function resetMobileNavbarScroll({ showNavbar = true } = {}) {
  mobileNavbarLastScrollY = Math.max(window.scrollY, 0);
  mobileNavbarDirection = null;
  mobileNavbarScrollDistance = 0;
  if (showNavbar) setMobileNavbarHidden(false);
}

function handleMobileNavbarScroll() {
  if (mobileNavbarFrame !== null) return;

  mobileNavbarFrame = window.requestAnimationFrame(() => {
    mobileNavbarFrame = null;
    const currentScrollY = Math.max(window.scrollY, 0);

    if (!MOBILE_NAVBAR_MEDIA.matches) {
      resetMobileNavbarScroll();
      return;
    }

    if (currentScrollY <= MOBILE_NAVBAR_TOP_LIMIT) {
      resetMobileNavbarScroll();
      return;
    }

    const delta = currentScrollY - mobileNavbarLastScrollY;
    mobileNavbarLastScrollY = currentScrollY;
    if (Math.abs(delta) < 2) return;

    const direction = delta > 0 ? "down" : "up";
    if (direction !== mobileNavbarDirection) {
      mobileNavbarDirection = direction;
      mobileNavbarScrollDistance = 0;
    }

    mobileNavbarScrollDistance += Math.abs(delta);
    if (mobileNavbarScrollDistance < MOBILE_NAVBAR_SCROLL_THRESHOLD) return;

    setMobileNavbarHidden(direction === "down");
    mobileNavbarScrollDistance = 0;
  });
}

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

function friendlyErrorMessage(error) {
  const messages = {
    "poll-code-required": "Enter a poll code first.",
    "poll-not-found": "Poll not found",
    "already-voted": "You have already voted in this poll.",
    "failed-precondition": "This poll is no longer accepting votes.",
    "invalid-argument": "Please check the poll details and try again.",
    "not-found": "Poll not found",
    "unauthenticated": "We couldn't verify your session. Please refresh and try again.",
    "permission-denied": "You don't have permission to do that.",
    "unavailable": "The voting service is unavailable. Please try again shortly.",
    "auth/account-exists-with-different-credential": "This email already uses another sign-in method.",
    "auth/credential-already-in-use": "This Google account is already connected to EasyVote.",
    "auth/network-request-failed": "We couldn't reach Google Sign-In. Check your connection and try again.",
    "auth/popup-blocked": "Your browser blocked the Google Sign-In window. Allow popups and try again.",
    "auth/popup-closed-by-user": "Google Sign-In was canceled.",
    "auth/unauthorized-domain": "Google Sign-In is not enabled for this domain yet.",
    "functions/already-exists": "You have already voted in this poll.",
    "functions/failed-precondition": "This poll is no longer accepting votes.",
    "functions/invalid-argument": "Please check the poll details and try again.",
    "functions/not-found": "Poll not found",
    "functions/unauthenticated": "We couldn't verify your session. Please refresh and try again.",
    "functions/permission-denied": "You don't have permission to do that.",
    "functions/unavailable": "The voting service is unavailable. Please try again shortly."
  };
  return messages[error?.code] || "Something went wrong. Please try again.";
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

function navbarLinks() {
  const createIsActive = currentView === "create" || currentView === "created";
  const myPollsIsActive = currentView === "my-polls";
  return `<nav class="navbar-links" aria-label="Primary navigation">
    <button class="navbar-link${createIsActive ? " is-active" : ""}" type="button" data-action="create"${createIsActive ? ' aria-current="page"' : ""}>Create poll</button>
    <button class="navbar-link${myPollsIsActive ? " is-active" : ""}" type="button" data-action="my-polls"${myPollsIsActive ? ' aria-current="page"' : ""}>My Polls</button>
  </nav>`;
}

function safeAvatarUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function accountLabel(user) {
  return user?.displayName?.trim() || user?.email?.split("@")[0] || "Account";
}

function accountAvatar(user) {
  const photoUrl = safeAvatarUrl(user?.photoURL);
  if (photoUrl) {
    return `<img class="account-avatar-image" src="${escapeHtml(photoUrl)}" alt="" referrerpolicy="no-referrer" />`;
  }
  const initial = accountLabel(user).charAt(0).toUpperCase() || "A";
  return `<span class="account-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

function navbarAccount() {
  const user = getAuthUser();
  if (isRegisteredUser(user)) {
    const label = accountLabel(user);
    return `<div class="navbar-account" aria-label="Account navigation">
      <div class="account-control">
        <button class="account-button" type="button" data-action="account-menu" aria-expanded="${accountMenuOpen}" aria-haspopup="menu" aria-label="Open account menu for ${escapeHtml(label)}">
          <span class="account-avatar">${accountAvatar(user)}</span>
          <span class="account-name">${escapeHtml(label.split(/\s+/)[0])}</span>
          <svg class="account-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
        </button>
        ${accountMenuOpen ? `<div class="account-menu" role="menu">
          <div class="account-menu-identity">
            <strong>${escapeHtml(label)}</strong>
            ${user.email ? `<span>${escapeHtml(user.email)}</span>` : ""}
          </div>
          <button type="button" data-action="sign-out" role="menuitem">Sign out</button>
        </div>` : ""}
      </div>
      ${themeToggle()}
    </div>`;
  }

  return `<div class="navbar-account" aria-label="Account navigation">
    <button class="navbar-sign-in" type="button" data-action="sign-in">Sign in</button>
    <button class="navbar-enter" type="button" data-action="sign-in">Enter</button>
    ${themeToggle()}
  </div>`;
}

function refreshNavbarAccount() {
  const currentAccount = document.querySelector(".navbar-account");
  if (!currentAccount) return;
  const template = document.createElement("template");
  template.innerHTML = navbarAccount().trim();
  currentAccount.replaceWith(template.content.firstElementChild);
  applyTheme(document.documentElement.dataset.theme, false);
}

function layout(content, modifier = "") {
  const transitionClass = shouldAnimateNextView ? " view-enter" : "";
  shouldAnimateNextView = false;
  app.innerHTML = `<main class="page ${modifier}">
    <header class="site-header">${logo()}${navbarLinks()}${navbarAccount()}</header>
    <div class="view-content${transitionClass}">${content}</div>
  </main>`;
}

function stopPolling() {
  if (pollUnsubscribe) pollUnsubscribe();
  pollUnsubscribe = null;
}

function navigate(view, { poll = null, replaceUrl = true } = {}) {
  stopPolling();
  accountMenuOpen = false;
  shouldAnimateNextView = view !== currentView;
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
  if (view === "my-polls") renderMyPolls();
  if (view === "created") renderCreated();
  if (view === "poll") subscribeToPoll(activePoll?.code, renderPoll);
  if (view === "results") subscribeToPoll(activePoll?.code, renderResults);
}

function renderMyPolls() {
  hasUnsavedDraft = false;
  const user = getAuthUser();
  if (!isRegisteredUser(user)) {
    myPollsRequestId += 1;
    layout(`<section class="empty-state my-polls-empty">
      <p class="eyebrow">My Polls</p>
      <h1>Sign in to see your polls</h1>
      <p>Keep track of the polls you create and access them anytime.</p>
      <button class="button button-primary" type="button" data-action="sign-in">Sign in with Google</button>
    </section>`);
    return;
  }

  const requestId = ++myPollsRequestId;
  layout(`<section class="my-polls-page">
    <div class="page-intro">
      <p class="eyebrow">My Polls</p>
      <h1>Welcome back, ${escapeHtml(accountLabel(user).split(/\s+/)[0])}.</h1>
      <p>Polls you create are saved to your account.</p>
    </div>
    <div class="my-polls-loading" role="status">Loading your polls…</div>
  </section>`);
  loadMyPolls(user.uid, requestId);
}

function pollCreatedLabel(createdAt) {
  if (!createdAt) return "Created recently";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Created recently";
  return `Created ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
}

function renderMyPollsResults(user, polls) {
  const content = polls.length
    ? `<div class="my-polls-grid">${polls.map(poll => `<article class="my-poll-card">
        <div class="my-poll-card-heading">
          <span class="poll-status">${escapeHtml(poll.status || "open")}</span>
          <span class="poll-code-label">${escapeHtml(poll.code)}</span>
        </div>
        <h2>${escapeHtml(poll.question)}</h2>
        <p>${poll.totalVotes || 0} ${(poll.totalVotes || 0) === 1 ? "vote" : "votes"} · ${escapeHtml(pollCreatedLabel(poll.createdAt))}</p>
        <div class="my-poll-actions">
          <button class="button button-secondary" type="button" data-action="open-my-poll" data-code="${escapeHtml(poll.code)}">View poll</button>
          <button class="text-button" type="button" data-action="open-my-results" data-code="${escapeHtml(poll.code)}">Results</button>
        </div>
      </article>`).join("")}</div>`
    : `<div class="my-polls-empty-account">
        <h2>No polls yet</h2>
        <p>Create your first poll and it will appear here.</p>
        <button class="button button-primary" type="button" data-action="create">Create Poll</button>
      </div>`;

  layout(`<section class="my-polls-page">
    <div class="page-intro">
      <p class="eyebrow">My Polls</p>
      <h1>Welcome back, ${escapeHtml(accountLabel(user).split(/\s+/)[0])}.</h1>
      <p>Polls you create are saved to your account.</p>
    </div>
    ${content}
  </section>`);
}

async function loadMyPolls(uid, requestId) {
  try {
    const response = await listMyPollsSecure();
    const user = getAuthUser();
    if (requestId !== myPollsRequestId || currentView !== "my-polls" || user?.uid !== uid) return;
    renderMyPollsResults(user, Array.isArray(response.polls) ? response.polls : []);
  } catch (error) {
    if (requestId !== myPollsRequestId || currentView !== "my-polls") return;
    showToast(friendlyErrorMessage(error), "error");
    layout(`<section class="empty-state my-polls-empty">
      <p class="eyebrow">My Polls</p>
      <h1>We couldn't load your polls</h1>
      <p>Please try again in a moment.</p>
      <button class="button button-primary" type="button" data-action="retry-my-polls">Try again</button>
    </section>`);
  }
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
  </section>
  <section class="features" aria-labelledby="features-title">
    <div class="features-intro">
      <p class="eyebrow">Made for quick decisions</p>
      <h2 id="features-title">Everything you need to decide, together.</h2>
    </div>
    <div class="features-grid">
      <article class="feature-card">
        <span class="feature-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 19.5h14M7.5 16.5l8.9-8.9a2.1 2.1 0 0 0-3-3l-8.9 8.9L4 17l3.5-.5Z" /></svg></span>
        <h3>Create in seconds</h3>
        <p>Build a poll with your own question and options in just a few clicks.</p>
      </article>
      <article class="feature-card">
        <span class="feature-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v8M8 12h8" /></svg></span>
        <h3>Share instantly</h3>
        <p>Every poll gets a simple code and link, ready to share anywhere.</p>
      </article>
      <article class="feature-card">
        <span class="feature-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 18V11M12 18V6M19 18v-4" /><path d="M4 20h16" /></svg></span>
        <h3>Live results</h3>
        <p>Watch votes and percentages update in real time as people decide.</p>
      </article>
      <article class="feature-card">
        <span class="feature-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 7 3.5v5.2c0 4.1-2.7 7.9-7 9.3-4.3-1.4-7-5.2-7-9.3V6.5L12 3Z" /><path d="m8.8 12 2.1 2.1 4.3-4.4" /></svg></span>
        <h3>Secure voting</h3>
        <p>Votes are securely processed to help keep results reliable and fair.</p>
      </article>
    </div>
  </section>
  <footer class="site-footer">
    <p>© 2026 EasyVote. All Rights Reserved.</p>
  </footer>`);

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
  layout(`<section class="empty-state"><p class="eyebrow">EasyVote</p><h1>Poll not found</h1><p>Check the code and try again.</p><button class="button button-primary" type="button" data-action="home">Back home</button></section>`);
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
  const response = await createPollSecure({
    question: createDraft.question,
    options: createDraft.options
  });
  return response.poll;
}

async function joinPoll(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw Object.assign(new Error("Poll code is required."), { code: "poll-code-required" });
  const snapshot = await getDoc(doc(db, "polls", code));
  if (!snapshot.exists()) throw Object.assign(new Error("Poll not found."), { code: "poll-not-found" });
  navigate("poll", { poll: snapshot.data() });
}

async function vote() {
  if (!activePoll || !selectedOptionId) return;
  await castVoteSecure({ code: activePoll.code, optionId: selectedOptionId });
  showToast("Vote recorded. Thanks!", "success");
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

async function handleGoogleSignIn() {
  if (signInInProgress) return;
  signInInProgress = true;
  const buttons = [...document.querySelectorAll("[data-action='sign-in']")];
  for (const button of buttons) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = "Signing in…";
  }

  try {
    const result = await signInWithGoogle(mergeAnonymousAccountSecure);
    accountMenuOpen = false;
    const migrationMessage = result.transferredPolls
      ? ` Signed in and moved ${result.transferredPolls} ${result.transferredPolls === 1 ? "poll" : "polls"} to your account.`
      : " Signed in with Google.";
    showToast(migrationMessage.trim());
    if (currentView === "my-polls") renderMyPolls();
    else refreshNavbarAccount();
  } finally {
    signInInProgress = false;
    for (const button of buttons) {
      if (!button.isConnected) continue;
      button.disabled = false;
      button.textContent = button.dataset.originalText || "Sign in";
      delete button.dataset.originalText;
    }
  }
}

async function handleSignOut() {
  accountMenuOpen = false;
  await signOutToGuest();
  showToast("Signed out. You're continuing as a guest.");
  if (currentView === "my-polls") renderMyPolls();
  else refreshNavbarAccount();
}

async function openMyPoll(code, destination) {
  const snapshot = await getDoc(doc(db, "polls", code));
  if (!snapshot.exists()) throw Object.assign(new Error("Poll not found."), { code: "poll-not-found" });
  navigate(destination, { poll: snapshot.data() });
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
    showToast(friendlyErrorMessage(error), "error");
    const button = event.target.querySelector('[type="submit"]');
    if (button) { button.disabled = false; button.textContent = event.target.id === "create-poll-form" ? "Create Poll" : "Join"; }
  }
});

document.addEventListener("click", async event => {
  const target = event.target.closest("[data-action]");
  if (!target) {
    if (accountMenuOpen && !event.target.closest(".account-control")) {
      accountMenuOpen = false;
      refreshNavbarAccount();
    }
    return;
  }
  const { action } = target.dataset;
  try {
    if (action === "toggle-theme") applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    if (action === "home") { if (confirmLeaveDraft()) navigate("home"); }
    if (action === "create") navigate("create");
    if (action === "my-polls") { if (confirmLeaveDraft()) navigate("my-polls"); }
    if (action === "sign-in") await handleGoogleSignIn();
    if (action === "account-menu") {
      accountMenuOpen = !accountMenuOpen;
      refreshNavbarAccount();
    }
    if (action === "sign-out") await handleSignOut();
    if (action === "retry-my-polls") renderMyPolls();
    if (action === "open-my-poll") await openMyPoll(target.dataset.code, "poll");
    if (action === "open-my-results") await openMyPoll(target.dataset.code, "results");
    if (action === "add-option" && createDraft.options.length < MAX_OPTIONS) { createDraft.options.push(""); renderCreate(); }
    if (action === "remove-option") { createDraft.options.splice(Number(target.dataset.optionIndex), 1); renderCreate(); }
    if (action === "view-poll") navigate("poll", { poll: activePoll });
    if (action === "select-option") { selectedOptionId = target.dataset.optionId; renderPoll(activePoll); }
    if (action === "vote") await vote();
    if (action === "copy-code") await copyText(activePoll.code, "Code copied!");
    if (action === "copy-link") await copyText(pollUrl(activePoll.code), "Link copied!");
  } catch (error) {
    showToast(friendlyErrorMessage(error), "error");
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && accountMenuOpen) {
    accountMenuOpen = false;
    refreshNavbarAccount();
  }
});

window.addEventListener("scroll", handleMobileNavbarScroll, { passive: true });
MOBILE_NAVBAR_MEDIA.addEventListener("change", () => resetMobileNavbarScroll());

window.addEventListener("popstate", () => {
  const code = new URLSearchParams(window.location.search).get("poll");
  if (code) navigate("poll", { poll: { code }, replaceUrl: false });
  else navigate("home", { replaceUrl: false });
});

subscribeToAuthState(user => {
  if (!isRegisteredUser(user)) accountMenuOpen = false;
  if (currentView === "my-polls") renderMyPolls();
  else refreshNavbarAccount();
});

const initialCode = new URLSearchParams(window.location.search).get("poll");
if (initialCode) navigate("poll", { poll: { code: initialCode }, replaceUrl: false });
else navigate("home", { replaceUrl: false });
