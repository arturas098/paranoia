# Paranoia v9

Paranoia v7 (design + all features) moved from Macaly/Convex to **ntfy**.

- Each chat link = its own AES-256-GCM key after `#` (never sent anywhere) + its own ntfy topic.
- Every action (message, like, 60 s destroy, timer, 24 h delete, typing, ✓✓, photo, voice, ding dong, panic) is an encrypted event on that topic; the server only sees ciphertext.
- Server is changeable in Settings (ntfy.sh now, own Termux + Tailscale Funnel later) – chats move automatically.
- Limits of ntfy.sh: messages cached ~12 h, attachments ~3 h (kept on the device once received); notifications only while the app is open / in background.

Live: https://arturas098.github.io/paranoia/

Source: `app/` (`npm i && npm run build`, copy `app/dist/*` to repo root).
