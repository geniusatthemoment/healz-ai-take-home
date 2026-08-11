# Healz Mobile Shell QA Checklist

## Goal

Validate the production-ish mobile shell around `https://app.healz.ai` before adding native document upload.

## Device Setup

1. Launch the Android app on a real device or stable emulator.
2. Confirm the app opens into the Healz landing or auth flow.
3. Confirm the branded icon and splash are visible.

## Login Flow

1. Tap the primary entry CTA that leads into sign-up or sign-in.
2. Enter email and request the login code.
3. Complete login with the email code.

Expected:
- No blank screens during auth.
- No unexpected redirect to external browser unless the site explicitly requires it.
- After successful auth, the user lands inside Healz and can continue normally.

## Session Persistence

1. Log in fully.
2. Background the app.
3. Force close the app.
4. Open the app again.

Expected:
- The user is still authenticated.
- The app restores into Healz without asking for the email code again.

## Navigation

1. Open at least one internal page after login.
2. Use the Android back button.

Expected:
- Back navigates inside the web history first.
- The app should not close immediately if there is internal history to return to.

## External Links

1. Tap a known external link, for example press or legal links that leave `healz.ai`.
2. Tap `mailto:` if available.

Expected:
- External websites open outside the app.
- `mailto:`, `tel:`, `sms:`, and similar system links hand off to the OS.
- The main Healz session remains intact when the user returns.

## Pull To Refresh

1. Pull down on the landing page.
2. Pull down inside an authenticated page.

Expected:
- Refresh works without breaking session state.
- If it feels jumpy or risky in chat, disable it before final APK.

## Error States

1. Turn off internet temporarily.
2. Reopen the app or refresh the page.

Expected:
- The app shows the custom retry screen instead of a raw React Native warning.
- `Retry` works after the network returns.

## Share Target Chat Picker

1. From Gallery or Files, share one PDF or image to Healz.
2. Wait for the native chat picker to show the available Healz chats.
3. Select an existing chat.

Expected:
- The selected chat opens in the WebView.
- The file is attached to that chat, not to an arbitrary chat.

Repeat with `New chat`, then test refresh and cancel.

## Record For Video

Show these moments:

1. Launch splash and icon.
2. Login with code.
3. Force close and reopen with the session preserved.
4. Back navigation.
5. External link handoff and return.
