"""retention — deletes meeting recordings Open WebUI keeps after transcription.

Open WebUI stores every uploaded file for good: a recording as <id>_<name>.wav plus the .mp3 and
.json it derives, and a row in its `file` table. Recordings are personal data with a retention
period (AUDIO_RETENTION_DAYS, default 30): this job deletes audio files older than that — the
row (chat links go with it, ON DELETE CASCADE) and every <id>_* file in the uploads directory.
The speaker-labelled transcript is not lost: the Meeting Agent keeps its own copy for its own
retention period, and minutes, decisions and Action Items stay.

Runs every INTERVAL_HOURS (6). DRY_RUN=1 only logs what it would delete.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import psycopg

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("retention")

DATABASE_URL = os.environ["OPENWEBUI_DATABASE_URL"]
UPLOADS = Path(os.environ.get("UPLOADS_DIR", "/app/backend/data/uploads"))
RETENTION_DAYS = int(os.environ.get("AUDIO_RETENTION_DAYS", "30"))
INTERVAL_HOURS = float(os.environ.get("INTERVAL_HOURS", "6"))
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"


def expired_audio(conn: psycopg.Connection, now: float) -> list[tuple[str, str | None]]:
    cutoff = int(now - RETENTION_DAYS * 86400)
    rows = conn.execute(
        r"""SELECT id, path FROM file
           WHERE created_at < %s AND (meta->>'content_type' LIKE 'audio/%%' OR filename ~* '\.(wav|mp3|m4a|webm|ogg|flac)$')""",
        (cutoff,),
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def files_of(file_id: str) -> list[Path]:
    # Open WebUI names uploads <id>_<original name>; the .mp3 / .json it derives share the prefix.
    return [p for p in UPLOADS.glob(f"{file_id}_*") if p.is_file()]


def run_once(now: float | None = None) -> int:
    now = now if now is not None else time.time()
    deleted = 0
    with psycopg.connect(DATABASE_URL, connect_timeout=10) as conn:
        for file_id, _path in expired_audio(conn, now):
            paths = files_of(file_id)
            if DRY_RUN:
                log.info("would delete %s (%s)", file_id, ", ".join(p.name for p in paths) or "no files")
                continue
            # Files first: if deleting the row then fails, the next pass finds the row again and finishes.
            for p in paths:
                p.unlink(missing_ok=True)
            conn.execute("DELETE FROM file WHERE id = %s", (file_id,))
            conn.commit()
            deleted += 1
            log.info("deleted recording %s (%d files)", file_id, len(paths))
    return deleted


def main() -> None:
    log.info("audio retention: %d days, every %.1fh, uploads %s%s", RETENTION_DAYS, INTERVAL_HOURS, UPLOADS,
             " (dry run)" if DRY_RUN else "")
    while True:
        try:
            run_once()
        except Exception:
            log.exception("retention pass failed")
        time.sleep(INTERVAL_HOURS * 3600)


if __name__ == "__main__":
    main()
