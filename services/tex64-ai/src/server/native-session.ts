import { createHmac } from "node:crypto";

export const NATIVE_SESSION_TOKEN_ENV = "TEX64_AI_NATIVE_SESSION_TOKEN";
export const NATIVE_SESSION_CHALLENGE_QUERY = "nativeChallenge";
export const NATIVE_SESSION_PROOF_HEADER = "x-tex64-native-proof";

/**
 * Proves that a health response came from the child that received the random
 * launch token. The challenge is sent over loopback, but the token itself is
 * not, so a process squatting on the chosen port cannot impersonate Next by
 * echoing a credential it just observed.
 */
export const nativeSessionHealthProof = (token: string, challenge: string): string =>
  createHmac("sha256", token).update(challenge, "utf8").digest("base64url");
