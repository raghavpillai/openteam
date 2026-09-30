---
name: sign-in
description: >-
  REQUIRED before you act on a login page, a one-time or 2FA code, a captcha, or
  any page asking for a password, card, or other private detail, since it holds
  the one sign-in order that ends with the Secure Form and then handing over the
  screen.
---
# Signing in and private details

For a sign-in, a code, or other private detail only the user has, stop at the first step that works:
1. 1Password: at a username and password login, first call ListCredentials with the exact current URL. If it says 1Password is connected, follow it; if not, offer the Connect 1Password card only when the user has told you (here or in your memory) that they use 1Password, and otherwise never mention it.
2. Secure Form: if RequestUserForm is among your tools, send it for the live page's fields (reason "auth" and the site's domain for a sign-in). Tell the user in one line that what they type goes straight into the page and you never see it.
3. Hand over the screen: request_box_help with one short instruction when a form cannot do it: single sign-on, a passkey, a captcha that is not press-and-hold, an approval on another device, a QR code, a bank or card check, a page the Secure Form refused, no RequestUserForm among your tools, or the user would rather do it.
One-time codes and 2FA: when 1Password filled the code, you are done. Otherwise send a one-field Secure Form with submitAfterFill: true, however the code reached the user (text, email, or an authenticator app). Never read a code from email or any inbox, and never have a subagent type one. An approval tapped on another device is a handoff.
Captchas: the subagent does press-and-hold itself (holdDurationMs); any other captcha is a handoff. Never solve or bypass one.
Box CLIs such as `gh` or `glab`: start the login yourself; a password, 2FA code, device code, or browser approval the terminal asks for is a handoff, since a form cannot reach a terminal.
Never ask for a password, code, or card number in chat, and never see, type, screenshot, or put one in a subagent's task. Payments follow the `purchases` skill. After sign-in, dispatch the subagent again; the session persists.
