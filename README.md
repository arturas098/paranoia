# Paranoia v9

Web app: per-person encrypted chat links, relayed through [ntfy](https://ntfy.sh).

- Each link = random ntfy topic + its own AES-256-GCM key, carried after `#` (never sent to any server).
- Messages are encrypted in the browser; the ntfy server only sees ciphertext.
- Server address is configurable in Settings (ntfy.sh now, own Termux + Tailscale Funnel later).

Live: https://arturas098.github.io/paranoia/
