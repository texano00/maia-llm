# Feature Specification: Web Access — passwordless entry and the web-only pivot

**Feature Branch**: `005-web-access`
**Created**: 2026-11-13
**Status**: Draft

**Input**: Distribution pivot — Maia LLM becomes a single web application at
`web.maiallm.com`; the desktop client is retired; access is passwordless with an
email and a one-time code; one page for both first entry and return; a captcha
guards it.

## User Scenarios & Testing

### User Story 1 — Enter without a password (P1)

A person opens `web.maiallm.com`, types their email, receives a code, enters it,
and lands in the app. The same page creates the account the first time and signs
in afterwards; there is no sign-up form and no password.

**Acceptance scenarios**

1. Given a new visitor, when they submit a valid address, then a one-time code is
   sent and the page asks for it, making clear that entering it creates the
   account.
2. Given a returning user, when they submit the same address, then the flow is
   identical — no separate sign-in screen.
3. Given a code that has expired or was already used, when it is submitted, then
   it is refused with a message offering a new code.
4. Given the correct code, when it is accepted, then a session is created and the
   user's own models and chats are shown.
5. Given the user closed the tab before entering the code, when they come back,
   then the flow starts again from the email field.

### User Story 2 — Attempts are rate limited and non-automatable (P1)

Codes cannot be brute-forced, abused to send unsolicited email, or farmed by
bots.

**Acceptance scenarios**

1. Given the access page, when it renders, then a captcha must be completed
   before a code is requested.
2. Given more than N codes requested for one address in a window, when another
   is requested, then the request is refused with an explanation of the wait.
3. Given more than M wrong codes for one address, when another is submitted,
   then the code is invalidated and a new one must be requested.
4. Given an invalid captcha, when the form is submitted, then no email is sent.

### User Story 3 — Access controls data, nothing else (P1)

The email identifies the owner of models, chats and provider keys — it is not a
profile, and it can be removed.

**Acceptance scenarios**

1. Given two accounts, when each signs in, then neither can see the other's
   conversations, images or credentials.
2. Given a signed-in session, when the user signs out, then the session stops
   working immediately on that browser.
3. Given a user asks for deletion, when it is confirmed, then their conversations,
   images, credentials and identity are removed.

### Edge Cases

- Email delivery fails or is delayed: the page says the code may take a minute,
  offers a resend, and never reveals whether an address exists.
- A code is requested while another is still valid: the previous code is
  invalidated.
- The browser blocks the session cookie: the page explains that sign-in cannot be
  kept and offers a fresh code.
- The captcha service is unreachable: access fails closed with a retry, no code is
  sent.
- Someone tries an address that belongs to an existing account: the response is
  identical to a new address, so accounts cannot be enumerated.

## Requirements

- **FR-001**: A single access page MUST handle both first entry and return; there
  MUST be no separate sign-up screen and no password field anywhere.
- **FR-002**: The page MUST request a one-time code for an email address and MUST
  accept only a valid, unexpired, unused code.
- **FR-003**: Codes MUST expire within ten minutes, MUST be single-use, and MUST
  be invalidated when a newer code is issued for the same address.
- **FR-004**: Every response MUST be indistinguishable between a known and an
  unknown address.
- **FR-005**: Code requests MUST require a passed captcha.
- **FR-006**: Code requests and code attempts MUST be rate limited per address and
  per source address, with a documented window and limit.
- **FR-007**: Provider credentials MUST be encrypted at rest with a server key and
  bound to the account that stored them.
- **FR-008**: All user data MUST be scoped to the email that created it; no
  endpoint may return another account's data.
- **FR-009**: Signing out MUST invalidate the session server-side.
- **FR-010**: Account deletion MUST remove conversations, images, credentials and
  the identity record.
- **FR-011**: The product MUST be reachable at `web.maiallm.com` with no
  installation step, and MUST NOT ship a desktop binary, installer, auto-updater
  or local proxy.

## Success Criteria

- **SC-001**: A first-time visitor reaches a usable catalogue in under two minutes
  using only an email address.
- **SC-002**: 100% of sign-in attempts that fail on the code offer a resend and a
  clear reason, with no account disclosure.
- **SC-003**: Zero cross-account data exposure in contract tests for every
  account-scoped endpoint.
- **SC-004**: Brute force is impractical: after the documented attempt limit, a
  code is invalidated and requests are throttled.

## Clarifications

### Session 2026-11-13

- Q: How aggressively should the desktop app be removed? → A: Delete it now; the
  web app is the product.
- Q: How should confirmation codes be delivered? → A: SMTP configured by
  environment variables, with a development mode that logs the code instead of
  sending it.
- Q: Which captcha? → A: Cloudflare Turnstile.
