"""Helper for reading message templates from DB with file fallback."""

import json
import os
from pathlib import Path

_db_templates = None


def set_db(db):
    global _db_templates
    _db_templates = db


def get_template(template_name: str) -> str:
    """Read a message template. Tries DB first, falls back to file."""
    if _db_templates and hasattr(_db_templates, 'message_templates'):
        try:
            row = _db_templates.message_templates.get_by_name(template_name)
            if row and row.get('content'):
                return row['content']
        except Exception:
            pass
    path = Path('embeds') / template_name
    if path.exists():
        with open(str(path), 'r') as f:
            return f.read()
    return ''
