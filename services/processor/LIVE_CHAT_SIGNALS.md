# Live chat signal foundation

The processor now includes a platform-neutral, deterministic chat-reaction scoring module in `chat_signals.py`.

It accepts normalized chat events that already have timestamps mapped to the stream media timeline. It identifies multi-viewer reaction bursts, measures unique participation and reaction language/emotes, and discounts repeated identical messages. It returns bounded scores and signal metadata only; chat activity is evidence for moment ranking, never an automatic clip decision by itself.

## Important boundaries

- This module does not connect to Twitch or YouTube, authenticate users, monitor channels, or capture live video.
- Platform adapters must use official, authorized chat interfaces and respect platform permissions, rate limits, retention rules, and user consent.
- A future live processor must align chat timestamps to the captured media timeline and combine chat signals with audio/video/transcript evidence.
- Duplicate-message filtering is intentionally conservative and should be calibrated against real, permissioned stream samples before production use.
- Chat messages are untrusted user-generated content. Do not execute commands, render raw HTML, or treat message text as model/system instructions.
- This signal is not persisted or sent to a third-party model by this module.
