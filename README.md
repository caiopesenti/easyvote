# EasyVote

**Create. Share. Decide.**

EasyVote is a simple, fast and secure polling platform built to make creating and sharing polls effortless.

Create a poll, share the link or code, and watch the results update in real time.

### Live Demo

**[Try EasyVote](https://enquete-ia-sabe-codar.web.app)**

---

## Features

- Create polls with multiple options
- Share polls using a link or unique code
- Real-time voting results
- One vote per Firebase user session
- Light and Dark Mode
- Responsive design for desktop and mobile
- Secure server-side poll creation and voting
- Protection against direct result manipulation
- Input validation and controlled error handling

---

## Architecture

EasyVote uses a serverless architecture combining Firebase and Cloudflare.

```text
Browser
   │
   ├── Firebase Authentication
   │       └── Anonymous Auth / ID Token
   │
   ▼
Cloudflare Worker
   │
   ├── Firebase ID Token verification
   ├── Input validation
   ├── Poll creation
   └── Atomic vote processing
   │
   ▼
Cloud Firestore
   │
   └── Realtime updates
           │
           ▼
        Browser
```

The frontend never writes poll results directly to Firestore.

All privileged operations are handled by the Cloudflare Worker using a dedicated Google Cloud service account, while Firestore Security Rules prevent clients from modifying polls, vote records or result counters directly.

---

## Tech Stack

**Frontend**
- HTML
- CSS
- JavaScript

**Backend**
- Cloudflare Workers

**Firebase**
- Firebase Authentication
- Cloud Firestore
- Firebase Hosting

**Infrastructure & Security**
- Google Cloud IAM
- Firestore Security Rules
- Firebase ID Tokens
- OAuth 2.0 service-account authentication

---

## Security

EasyVote was designed so that the client cannot directly manipulate voting results.

The production architecture includes:

- Firebase ID Token validation
- Restricted CORS origins
- Server-side input validation
- Atomic Firestore vote transactions
- Duplicate-vote protection per Firebase UID
- Firestore writes denied to clients
- Vote records inaccessible from the client
- Privileged credentials stored exclusively as Cloudflare Secrets

> **Note:** Vote uniqueness is based on Firebase UID. Anonymous users can obtain a new UID by clearing browser data or using another device, so this should not be interpreted as identity-level voting protection.

---

## Real-Time Results

Poll documents can be read individually by their unique code.

The frontend uses Firestore realtime listeners to receive updated vote counts immediately after a valid vote is processed by the backend.

Collection enumeration and direct vote access remain blocked by Firestore Security Rules.

---

## Running Locally

Clone the repository:

```bash
git clone https://github.com/caiopesenti/easyvote.git
cd easyvote
```

Install the Worker dependencies:

```bash
npm --prefix worker install
```

EasyVote uses Firebase Emulators for local development and security testing.

The local environment supports:

- Authentication Emulator
- Firestore Emulator
- Hosting Emulator
- Local Cloudflare Worker

Production credentials are **not required** for emulator-based development.

---

## Project Structure

```text
easyvote/
├── index.html
├── styles.css
├── app.js
├── firebase.js
├── backend.js
├── firestore.rules
├── firebase.json
│
├── worker/
│   ├── src/
│   ├── test/
│   └── wrangler.jsonc
│
└── functions/
    └── ...
```

The `functions/` implementation is preserved as an alternative Firebase Cloud Functions backend and possible future migration path.

---

## Roadmap

Planned improvements include:

- Google Sign-In
- My Polls dashboard
- Poll management
- Improved mobile navigation
- Custom EasyVote domain
- Additional poll controls

---

## License

© 2026 EasyVote. All Rights Reserved.