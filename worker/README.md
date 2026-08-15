# EasyVote Cloudflare Worker

This Worker is the Firebase Spark-compatible secure write layer for `createPoll`
and `castVote`. The existing Firebase callable Functions remain unchanged in
`../functions` as a fallback.

## Security model

- The browser signs in with Firebase Anonymous Auth and sends its Firebase ID
  token as a Bearer token.
- Production verifies the token signature with Google's Firebase public keys,
  plus `alg`, `aud`, `iss`, `sub`, `exp`, `iat`, and `auth_time` claims.
- The Worker obtains a short-lived Google OAuth access token from a dedicated
  service account and calls the Firestore REST API with server privileges.
- Poll creation uses an `exists: false` precondition. Voting reads the poll and
  UID vote document inside a Firestore transaction, then creates the vote and
  updates the counters in one atomic commit.
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

The local Worker listens on `http://127.0.0.1:8787`. The local frontend already
selects it automatically; production continues using the callable Functions
until `PRODUCTION_WORKER_URL` in `../backend.js` is filled after an approved
Worker deploy.

With the Auth and Firestore emulators running, execute:

```powershell
npm --prefix worker run test:validation
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
used. After deployment, set the public Worker URL in `../backend.js` to switch
production traffic from the preserved Functions fallback.
