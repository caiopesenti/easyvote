# EasyVote Cloudflare Worker

This Worker is the Firebase Spark-compatible secure API for `createPoll`,
`castVote`, `listMyPolls`, and `mergeAnonymousAccount`. The existing Firebase
callable Functions remain unchanged in `../functions` as a fallback.

## Security model

- The browser starts with Firebase Anonymous Auth and sends its Firebase ID
  token as a Bearer token. Google Sign-In is optional.
- Production verifies the token signature with Google's Firebase public keys,
  plus `alg`, `aud`, `iss`, `sub`, `exp`, `iat`, and `auth_time` claims.
- The Worker obtains a short-lived Google OAuth access token from a dedicated
  service account and calls the Firestore REST API with server privileges.
- Poll creation uses an `exists: false` precondition. Voting reads the poll and
  UID vote document inside a Firestore transaction, then creates the vote and
  updates the counters in one atomic commit.
- `listMyPolls` queries by the verified token UID with server privileges; the
  client still cannot list the `polls` collection directly.
- When direct anonymous-to-Google linking conflicts with an existing Firebase
  account, `mergeAnonymousAccount` verifies both tokens and transfers only the
  source user's poll ownership to that Google UID before the browser changes
  sessions. The target token must represent a Google identity. The Worker also
  records the merged anonymous UID server-side so `castVote` continues checking
  its previous vote evidence after the account changes UID.
- Firestore Rules remain client-deny for every write and for all vote reads.
- CORS reflects only an exact origin from `ALLOWED_ORIGINS`.

## Local development

Install the Worker dependencies once:

```powershell
npm --prefix worker install
```

Run the Firebase Auth, Firestore, and Hosting emulators from the project root,
using the existing JDK 21 test-session setup. In a second terminal, run:

```powershell
npm --prefix worker run dev
```

The local Worker listens on `http://127.0.0.1:8787`. The local frontend selects
it automatically, while production uses the published URL configured in
`../backend.js`. The callable Functions remain preserved as a fallback but are
not the active production path.

With the Auth and Firestore emulators running, execute:

```powershell
npm --prefix worker run test:validation
npm --prefix worker run test:auth
npm --prefix worker run test:security
```

To exercise the same suite through the real local `workerd` HTTP runtime, run
this while the Auth and Firestore emulators are active:

```powershell
npm --prefix worker run test:security:http
```

The full HTTP security suite can also start and stop its required services from
the project root in one command:

```powershell
firebase emulators:exec --project enquete-ia-sabe-codar --only auth,firestore "npm --prefix worker run test:security:http"
```

No real service-account credential is used in emulator mode. Emulator ID tokens
are unsigned, so the Worker accepts them only when all local-development guards
are active and the Worker request hostname is `localhost` or `127.0.0.1`.

## Production secrets

Create a dedicated Google Cloud service account with only the Firestore data
permissions needed by this API. Configure these values as Cloudflare Secrets,
never as plaintext `vars` or committed files:

- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

`FIREBASE_PROJECT_ID` and `ALLOWED_ORIGINS` are non-secret configuration in
`wrangler.jsonc`. Add a custom EasyVote domain there before deployment if one is
used. The public Worker URL in `../backend.js` is already configured; deploy the
reviewed Worker changes before deploying a frontend that depends on the account
endpoints.
