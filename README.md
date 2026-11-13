# Gemfire Online

Password-protected browser version of Gemfire (Sega Genesis, Koei 1992) with friend-code multiplayer. The ROM is stored AES-GCM encrypted. The page decrypts it in memory. The password and the plaintext ROM are not in this repo.

**Play:** https://joebu84.github.io/gemfire/

There is no game server. One player's browser tab runs the emulator, and friends connect straight to that tab.

## Play

1. Open the link and enter the password. Wrong passwords are rejected. **Remember on this tab** keeps it for this tab only.
2. **Play solo**, or **Host a game**. Hosting shows a 6-character code. **Copy link** copies a join link.
3. A friend opens the site, enters the password, presses **Join**, and types the code (or opens the link).
4. The host is player 1. The first friend is player 2, then player 3, then player 4. Up to three friends.

### Controls

| | Move | A | B | C | Start |
|---|---|---|---|---|---|
| Host | Arrow keys, or a gamepad | Z | X | C | Enter |
| Friend | Arrows or WASD, the on-screen pad, or a gamepad | Z or J | X or K | C or L | Enter or Space |

The host's emulator bar has save states, load state, and fullscreen. Battery-backed saves stay in that browser.

Gemfire checks for a multitap when it powers on. The page enables the **EA 4-Way Play** adapter, which maps players 1–4 to controller ports 1–4. If a 4-player game never appears in the menu, switch **Multitap** to **Sega Team Player**. That restarts the ROM.

## How multiplayer works

The host's tab is the Genesis. Friends do not run their own copy, so the game cannot drift out of sync. The host streams the picture and sound over WebRTC, and friends send their buttons back as controller ports 2, 3 and 4. A short delay is normal, and it suits a turn-based game.

Matchmaking uses the public [PeerJS](https://peerjs.com/) broker. A public TURN relay is a fallback for strict networks. Both are best-effort. Some school and corporate networks block WebRTC entirely.

`js/vendor/peerjs.min.js` is PeerJS 1.5.4 (MIT). The emulator UI and the Genesis Plus GX core load from the EmulatorJS CDN (`cdn.emulatorjs.org`, latest).

## Caveats

- **The game is online only while the host's tab is open and in front.** Hiding or closing it pauses the game for everyone. A computer is a better host than a phone.
- **Saves and save states live in the host's browser.** Clearing site data removes them.
- **Friends need the password too**, because the site is locked until it decrypts.
- The encrypted ROM and its parameters are `rom/gemfire.bin.enc` and `rom/gemfire.enc.json`. The page always reads the parameters from the JSON. Do not commit a decrypted ROM.

## Locally

```bash
python3 -m http.server
```

Then open http://localhost:8000. Opening the files directly will not work, because the page has to fetch the ROM.
