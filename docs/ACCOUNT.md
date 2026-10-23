# Player accounts

The title screen supports account registration and sign-in. Usernames are case-insensitive, 3–24 Unicode letters,
combining marks, or numbers, optionally including `_`, `.` or `-`; each name must include at least one letter or number.
Passwords are 8–128 characters. The server stores a per-account random salt and a scrypt
password hash, never the password. Account records and skin preferences are written to `.cache/accounts.json` in the
server installation. Back up that file with the server's other private data. Account bearer tokens are stored hashed in
the same file and expire after one year; signing in issues a new token. There is no password reset flow.

An account token is sent only in the WebSocket hello. When a device signs into an account that still has a recoverable
server session, the server transfers that session to the new socket and resends its room or match state. The previous
socket is disconnected. The existing reconnect windows still apply after the socket is lost: 10 minutes for co-op and
24 hours for an active solo run. Rooms, players' match state and the account-to-session map are in memory, so a server
restart ends running games; accounts and skins remain on disk.

Skin choices are loaded from the account on sign-in and in every authenticated WebSocket welcome, then saved whenever the client syncs a change. Other browser
preferences and operator loadouts remain local to each browser. This feature does not upload or synchronize game art.

The title screen offers a 记住密码 ("remember password") checkbox. When it is checked, a successful sign-in stores the
username and password in that browser's `localStorage` (`sp.rememberAuth`) and prefills both fields the next time the
title screen opens, so the player only has to press 登录. The password is base64-obfuscated, **not encrypted** — anyone
with access to that browser's storage can recover it — so it should only be enabled on a private device. Unchecking the
box (or signing in with it unchecked) clears the stored credentials. This is purely a client-side convenience and does
not change the server's account store, tokens or the WebSocket `hello` flow.

The login endpoints are `POST /api/account/register` and `POST /api/account/login`, each accepting JSON
`{ "username": "…", "password": "…" }`. Responses include an account token, username and skin-selection map. Failed
attempts are limited per network address.
