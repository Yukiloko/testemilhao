/** Chrome is not reachable over CDP. The queue pauses; the agent never launches its own Chrome. */
export class BrowserUnavailableError extends Error {}
/** Instagram shows the login wall: the operator must log in again by hand. */
export class SessionLostError extends Error {}
/** Instagram shows a restriction/"try again later"/action-blocked notice. */
export class InstagramRestrictionError extends Error {}
export class ProfileNotFoundError extends Error {}
/** The UI did not match expectations. `delivered` tells whether the send may have gone through. */
export class BrowserActionError extends Error {
  constructor(
    message: string,
    readonly delivered: "no" | "unknown",
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
