class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

class FirestoreError extends Error {
  constructor(status, firestoreStatus, message) {
    super(message || "Firestore request failed.");
    this.name = "FirestoreError";
    this.status = status;
    this.firestoreStatus = firestoreStatus;
  }
}

export { ApiError, FirestoreError };
