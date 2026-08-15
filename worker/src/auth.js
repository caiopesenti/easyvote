import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { ApiError } from "./errors.js";

const firebaseJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

function isEmulatorRequest(request, env) {
  const hostname = new URL(request.url).hostname;
  return env.ENVIRONMENT === "development"
    && env.FIREBASE_EMULATOR_MODE === "true"
    && Boolean(env.FIREBASE_AUTH_EMULATOR_HOST)
    && Boolean(env.FIRESTORE_EMULATOR_HOST)
    && ["localhost", "127.0.0.1"].includes(hostname);
}

function validateClaims(payload, projectId) {
  const now = Math.floor(Date.now() / 1000);
  const issuer = `https://securetoken.google.com/${projectId}`;

  if (payload.aud !== projectId || payload.iss !== issuer || typeof payload.sub !== "string" || !payload.sub) {
    throw new ApiError("unauthenticated", "Authentication is required.", 401);
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new ApiError("unauthenticated", "Authentication is required.", 401);
  }
  if (typeof payload.iat !== "number" || payload.iat > now + 30) {
    throw new ApiError("unauthenticated", "Authentication is required.", 401);
  }
  if (typeof payload.auth_time !== "number" || payload.auth_time > now + 30) {
    throw new ApiError("unauthenticated", "Authentication is required.", 401);
  }
  if (payload.user_id && payload.user_id !== payload.sub) {
    throw new ApiError("unauthenticated", "Authentication is required.", 401);
  }

  return payload.sub;
}

async function verifyFirebaseIdToken(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw new ApiError("unauthenticated", "Authentication is required.", 401);

  const idToken = match[1];
  try {
    if (isEmulatorRequest(request, env)) {
      const header = decodeProtectedHeader(idToken);
      if (header.alg !== "none" || !idToken.endsWith(".")) {
        throw new Error("Unexpected emulator token signature.");
      }
      return validateClaims(decodeJwt(idToken), env.FIREBASE_PROJECT_ID);
    }

    const { payload } = await jwtVerify(idToken, firebaseJwks, {
      algorithms: ["RS256"],
      audience: env.FIREBASE_PROJECT_ID,
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`
    });
    return validateClaims(payload, env.FIREBASE_PROJECT_ID);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("unauthenticated", "Authentication is required.", 401);
  }
}

export { verifyFirebaseIdToken };
