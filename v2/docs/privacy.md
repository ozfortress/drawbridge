# Privacy and retention

Owner decisions this document must implement (draft; completed in P11):

- **Purpose:** recording message activity serves match scheduling and team support for the tournament.
- **Scope:** only channels on a league's managed channel list. The bot does not read channels outside it.
- **What is kept:** messages (including edits and deletions), attachments, and reactions in managed channels, the match lifecycle, scheduling, logs.tf results and demo checks.
- **Retention:** 730 days from each event's source timestamp, enforced by the daily retention job. Logs and attachments survive a Discord channel deletion; only retention removes them.
- **Not collected:** channels outside the managed list, voice, direct messages.
- **Requests:** users may request redaction through the reporting channel named in the server FAQ. Redaction is audited.
- **No ML or profiling:** message content is never used to train or prompt models, and timelines are scoped to a league or a match.
