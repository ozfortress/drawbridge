"""Stop the same admin action from running twice at once.

Long-running admin actions (starting a tournament, generating a round, ending a
league...) can be triggered from both the web panel and slash commands. Since
Citadel calls no longer block the event loop, two of them can now overlap and,
for example, create every channel twice. Each action claims a key such as
``('start', league_id)`` while it runs; a second attempt with the same key is
rejected with ``ActionInProgress`` instead of doing the work again.

Everything runs on the bot's single event loop, so a plain dict is enough: the
check and the claim happen with no ``await`` in between.
"""

import contextlib
import functools

_running: dict[tuple, str] = {}


class ActionInProgress(Exception):
    """Raised when the same action is already running."""


def _key(action: str, targets) -> tuple:
    # str() so a league ID from JSON ('93') and from a slash command (93) match.
    return (action, *(str(t) for t in targets))


def is_running(action: str, *targets) -> bool:
    return _key(action, targets) in _running


def claim(label: str, action: str, *targets) -> None:
    """Claim ``(action, *targets)`` or raise ActionInProgress if it's taken.

    ``label`` describes the action for the error message, e.g. 'Starting league 93'.
    """
    key = _key(action, targets)
    if key in _running:
        raise ActionInProgress(f'{_running[key]} is already in progress. Wait for it to finish and try again.')
    _running[key] = label


def release(action: str, *targets) -> None:
    _running.pop(_key(action, targets), None)


@contextlib.contextmanager
def exclusive(label: str, action: str, *targets):
    """Hold ``(action, *targets)`` for the duration of the block."""
    claim(label, action, *targets)
    try:
        yield
    finally:
        release(action, *targets)


def exclusive_command(action: str, *arg_names: str, label: str):
    """Decorator for slash-command callbacks: holds ``(action, *args)`` while it runs.

    ``arg_names`` are the command parameters that identify the target (e.g.
    'league_id'); ``label`` is formatted with them, e.g. 'Starting league {league_id}'.
    """
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(self, interaction, *args, **kwargs):
            values = {name: kwargs.get(name) for name in arg_names}
            with exclusive(label.format(**values), action, *values.values()):
                return await func(self, interaction, *args, **kwargs)
        return wrapper
    return decorator
