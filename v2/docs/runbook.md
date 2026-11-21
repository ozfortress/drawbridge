# Runbook

Written in P12. Expected sections:

- Master key rotation (`DRAWBRIDGE_MASTER_KEY` / `DRAWBRIDGE_MASTER_KEY_ID`).
- Job decisions: retry, skip, adopt, revert, abort.
- Discord permission repair (role hierarchy, missing channel permissions).
- Capture gaps: backfill after gateway downtime.
- Backup and restore drill (Postgres, MinIO, configuration).
- Alert response (from the list in the plan's architecture section 12).
