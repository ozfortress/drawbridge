"""Discord UI for per-match scheduling (propose / confirm / counter-propose).

All scheduling happens in the match channel. Each generated match gets a pinned
"Propose Match Time" button. One captain proposes a day + time (presets or a
free-text custom time), the other team confirms or counter-proposes. Once
confirmed, the agreed time is stored and shown as a Discord dynamic timestamp.
"""

import re
import datetime
from zoneinfo import ZoneInfo

import discord
from discord.ui import View, Button, Select, Modal, TextInput

from modules.Drawbridge.checks import Checks

SYDNEY = ZoneInfo('Australia/Sydney')
_checks = Checks()
DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


# ── Time helpers ─────────────────────────────────────────────

def next_occurrence(day_of_week: int, time_str: str,
                    now: datetime.datetime | None = None) -> datetime.datetime:
    """Return the next future occurrence of ``day_of_week`` at ``time_str``
    (AEST/AEDT) as a timezone-aware UTC datetime.

    ``day_of_week``: 0=Mon .. 6=Sun (matches ``datetime.weekday()``).
    ``time_str``: 'HH:MM'.
    """
    now = now.astimezone(SYDNEY) if now else datetime.datetime.now(SYDNEY)
    hh, mm = (int(x) for x in time_str.split(':'))
    days_ahead = (day_of_week - now.weekday()) % 7
    candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0) \
        + datetime.timedelta(days=days_ahead)
    if candidate <= now:
        candidate += datetime.timedelta(days=7)
    return candidate.astimezone(datetime.timezone.utc)


def compute_deadline_utc(settings: dict | None,
                         now: datetime.datetime | None = None):
    """Compute a league's next weekly scheduling deadline as a naive UTC
    datetime (suitable for the ``datetime`` DB column), or None if not set."""
    if not settings:
        return None
    dd = settings.get('deadline_day')
    dt = settings.get('deadline_time')
    if dd is None or not dt:
        return None
    return next_occurrence(int(dd), dt, now).replace(tzinfo=None)


# Preset time slots offered in the dropdown (teams can also type any time).
_TIME_PRESETS = ['19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00']


def _fmt_time(time_str: str) -> str:
    """Render 'HH:MM' as a friendly 12-hour label, e.g. '8:45 PM'."""
    try:
        h, mi = (int(x) for x in time_str.split(':'))
        ap = 'AM' if h < 12 else 'PM'
        return f'{h % 12 or 12}:{mi:02d} {ap}'
    except Exception:
        return time_str


def parse_time(s: str) -> str | None:
    """Parse free-text time into 'HH:MM' (24-hour), or None if invalid.

    Accepts '20:45', '8:45pm', '8pm', '8:45 PM', etc.
    """
    s = s.strip().lower().replace(' ', '')
    m = re.fullmatch(r'(\d{1,2}):(\d{2})', s)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
    else:
        m = re.fullmatch(r'(\d{1,2})(?::(\d{2}))?(am|pm)', s)
        if not m:
            return None
        h = int(m.group(1)) % 12
        mi = int(m.group(2) or 0)
        if m.group(3) == 'pm':
            h += 12
    return f'{h:02d}:{mi:02d}' if 0 <= h <= 23 and 0 <= mi <= 59 else None


def _slot_label(day: int, time_str: str) -> str:
    return f'{DAY_NAMES[day]} {_fmt_time(time_str)}'


# ── DB / context helpers ─────────────────────────────────────

def _get_db():
    from web.admin_panel import _db
    return _db


def _playable_days(settings: dict | None) -> list[int]:
    """Playable days for the league: the format's range (if any) minus the
    league's excluded days. Falls back to all seven days."""
    excluded: set[int] = set()
    fmt = None
    if settings:
        fmt = settings.get('format')
        if settings.get('excluded_days'):
            excluded = {int(x) for x in str(settings['excluded_days']).split(',') if str(x).strip()}
    from modules.database.repositories import TournamentScheduleSettingsRepository
    preset = TournamentScheduleSettingsRepository.format_defaults(fmt)
    base = preset['playable_days'] if preset else list(range(7))
    return [d for d in base if d not in excluded]


def _resolve_context(db, match_id: int) -> dict | None:
    """Resolve match + both team rows + league settings for ``match_id``."""
    match = db.matches.get_by_id(match_id)
    if not match:
        return None
    league_id = match['league_id']
    home = db.teams.get_by_team_and_league(match['team_home'], league_id)
    away = db.teams.get_by_team_and_league(match['team_away'], league_id)
    settings = db.tournament_schedule_settings.get_by_league(league_id)
    return {
        'match': match, 'league_id': league_id,
        'home': home, 'away': away, 'settings': settings,
    }


def _member_side(member: discord.Member, home: dict | None, away: dict | None):
    """Return 'home' / 'away' if the member holds that team's role, else None."""
    role_ids = {r.id for r in member.roles}
    if home and home.get('role_id') in role_ids:
        return 'home'
    if away and away.get('role_id') in role_ids:
        return 'away'
    return None


def _is_admin(member: discord.Member) -> bool:
    admin_ids = set(_checks._get_role_ids('Head', 'Admin', 'Trial', 'Director', 'Developer'))
    return any(r.id in admin_ids for r in member.roles)


async def _refresh_launchpad():
    try:
        from web.admin_panel import _tournament_cog
        if _tournament_cog:
            await _tournament_cog.update_launchpad()
    except Exception:
        pass


# ── Propose flow (transient, ephemeral) ──────────────────────

class _DaySelect(Select):
    def __init__(self, days: list[int], selected: int | None):
        options = [
            discord.SelectOption(label=DAY_NAMES[d], value=str(d), default=(d == selected))
            for d in days
        ] or [discord.SelectOption(label='No playable days configured', value='-1')]
        super().__init__(placeholder='Pick a day…', options=options,
                         min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        view: ProposeView = self.view
        view.day = int(self.values[0])
        await interaction.response.edit_message(embed=view.build_embed(), view=view)


class _TimeSelect(Select):
    def __init__(self, selected: str | None):
        options = [
            discord.SelectOption(label=_fmt_time(t), value=t, default=(t == selected))
            for t in _TIME_PRESETS
        ]
        super().__init__(placeholder='Pick a time… (or use “Other time”)', options=options,
                         min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        view: ProposeView = self.view
        view.time = self.values[0]
        await interaction.response.edit_message(embed=view.build_embed(), view=view)


class ProposeView(View):
    """Ephemeral editor a captain uses to choose a day + time to propose."""

    def __init__(self, match_id: int, proposer_side: str, current_unix: int | None = None):
        super().__init__(timeout=300)
        self.match_id = match_id
        self.proposer_side = proposer_side  # 'home' | 'away'
        self.current_unix = current_unix    # set when rescheduling an already-confirmed match
        self.day: int | None = None
        self.time: str | None = None

        db = _get_db()
        ctx = _resolve_context(db, match_id) if db else None
        settings = ctx['settings'] if ctx else None
        self.add_item(_DaySelect(_playable_days(settings), self.day))
        self.add_item(_TimeSelect(self.time))
        send_label = 'Send New Time' if current_unix else 'Send Proposal'
        send = Button(label=send_label, style=discord.ButtonStyle.success, row=2)
        send.callback = self._on_send
        self.add_item(send)
        other = Button(label='⌨️ Other time…', style=discord.ButtonStyle.secondary, row=2)
        other.callback = self._on_other_time
        self.add_item(other)

    def build_embed(self) -> discord.Embed:
        rescheduling = self.current_unix is not None
        e = discord.Embed(
            title='🔁 Reschedule Match' if rescheduling else '📅 Propose a Match Time',
            description='Pick a day and a time, then **Send**. Need a time that '
                        'isn\'t listed (e.g. 8:45pm)? Use **Other time…**. The other team '
                        'will be asked to confirm or counter-propose.',
            color=discord.Color.blurple(),
        )
        if rescheduling:
            e.add_field(name='Currently scheduled',
                        value=f'<t:{self.current_unix}:F> — pick a new time below to reschedule.',
                        inline=False)
        chosen = _slot_label(self.day, self.time) if (self.day is not None and self.day >= 0 and self.time) else 'Nothing selected yet'
        e.add_field(name='Your proposal', value=chosen, inline=False)
        e.add_field(
            name='Note', inline=False,
            value='Times are AEST/AEDT. You can reschedule at any time, even after the '
                  'deadline — both teams just need to agree. Days outside the listed range '
                  'need an admin to approve.',
        )
        return e

    async def _commit(self, interaction: discord.Interaction, day: int, time: str) -> bool:
        """Record the proposal and post the Confirm/Counter message. No interaction
        response is sent here — callers handle their own ack."""
        db = _get_db()
        ctx = _resolve_context(db, self.match_id) if db else None
        if not ctx:
            return False
        proposer = ctx[self.proposer_side]
        other = ctx['away' if self.proposer_side == 'home' else 'home']
        db.match_schedules.set_proposal(
            self.match_id, day, time,
            proposer['team_id'] if proposer else None, interaction.user.id,
        )
        embed = discord.Embed(
            title='📅 Proposed Match Time',
            description=f"**{proposer['team_name'] if proposer else 'A team'}** proposed "
                        f"**{_slot_label(day, time)}**.",
            color=discord.Color.gold(),
        )
        embed.add_field(
            name='Next step',
            value='The other team can **Confirm** to lock it in, or **Counter-propose** a different time.',
            inline=False,
        )
        mention = f"<@&{other['role_id']}>" if other and other.get('role_id') else ''
        await interaction.channel.send(
            content=mention or None,
            embed=embed,
            view=ProposalDecisionView(self.match_id),
            allowed_mentions=discord.AllowedMentions(roles=True),
        )
        return True

    async def _on_send(self, interaction: discord.Interaction):
        if self.day is None or self.day < 0 or not self.time:
            await interaction.response.send_message(
                'Pick a valid day and time first. (If no days are available, an admin '
                'needs to adjust this league\'s excluded days.)', ephemeral=True)
            return
        if await self._commit(interaction, self.day, self.time):
            await interaction.response.edit_message(content='✅ Proposal sent.', embed=None, view=None)
        else:
            await interaction.response.send_message('This match is no longer being scheduled.', ephemeral=True)

    async def _on_other_time(self, interaction: discord.Interaction):
        if self.day is None or self.day < 0:
            await interaction.response.send_message('Pick a day first, then enter a custom time.', ephemeral=True)
            return
        await interaction.response.send_modal(CustomTimeModal(self))


class CustomTimeModal(Modal, title='Propose a custom time'):
    """Free-text time entry so teams can propose any time (e.g. 8:45pm)."""

    def __init__(self, parent_view: 'ProposeView'):
        super().__init__()
        self.parent_view = parent_view
        self.time_input = TextInput(
            label='Time (AEST/AEDT)',
            placeholder='e.g. 8:45pm or 20:45',
            required=True, max_length=10,
        )
        self.add_item(self.time_input)

    async def on_submit(self, interaction: discord.Interaction):
        norm = parse_time(str(self.time_input.value))
        if not norm:
            await interaction.response.send_message(
                'Couldn\'t read that time. Try `8:45pm` or `20:45`.', ephemeral=True)
            return
        view = self.parent_view
        if view.day is None or view.day < 0:
            await interaction.response.send_message('Pick a day first.', ephemeral=True)
            return
        if await view._commit(interaction, view.day, norm):
            await interaction.response.send_message(
                f'✅ Proposal sent: {_slot_label(view.day, norm)}.', ephemeral=True)
        else:
            await interaction.response.send_message('This match is no longer being scheduled.', ephemeral=True)


async def _open_propose(interaction: discord.Interaction, match_id: int):
    """Open the (re)schedule editor for the clicking team member. Works whether the
    match is unscheduled, mid-proposal, or already confirmed (reschedule)."""
    db = _get_db()
    ctx = _resolve_context(db, match_id) if db else None
    if not ctx:
        await interaction.response.send_message('Scheduling is not active for this match.', ephemeral=True)
        return
    side = _member_side(interaction.user, ctx['home'], ctx['away'])
    if side is None:
        await interaction.response.send_message(
            'Only a member of one of the competing teams can propose a time. '
            '(Admins can use /schedule.)', ephemeral=True)
        return
    sched = db.match_schedules.get_by_match_id(match_id)
    current_unix = None
    if sched and sched.get('status') == 'confirmed' and sched.get('scheduled_at'):
        current_unix = int(sched['scheduled_at'].replace(tzinfo=datetime.timezone.utc).timestamp())
    view = ProposeView(match_id, side, current_unix=current_unix)
    await interaction.response.send_message(embed=view.build_embed(), view=view, ephemeral=True)


class RescheduleView(View):
    """Persistent Reschedule button attached to a confirmed-time message."""

    def __init__(self, match_id: int):
        super().__init__(timeout=None)
        self.match_id = match_id
        btn = Button(label='🔁 Reschedule', style=discord.ButtonStyle.secondary,
                     custom_id=f'match_sched_reschedule_{match_id}')
        btn.callback = self._callback
        self.add_item(btn)

    async def _callback(self, interaction: discord.Interaction):
        await _open_propose(interaction, self.match_id)


# ── Decision flow (persistent) ───────────────────────────────

class ProposalDecisionView(View):
    """Persistent Confirm / Counter-propose buttons attached to a proposal."""

    def __init__(self, match_id: int):
        super().__init__(timeout=None)
        self.match_id = match_id
        confirm = Button(label='✅ Confirm', style=discord.ButtonStyle.success,
                         custom_id=f'match_sched_confirm_{match_id}')
        confirm.callback = self._on_confirm
        self.add_item(confirm)
        counter = Button(label='🔁 Counter-propose', style=discord.ButtonStyle.secondary,
                         custom_id=f'match_sched_counter_{match_id}')
        counter.callback = self._on_counter
        self.add_item(counter)

    def _load(self):
        db = _get_db()
        ctx = _resolve_context(db, self.match_id) if db else None
        sched = db.match_schedules.get_by_match_id(self.match_id) if db else None
        return db, ctx, sched

    def _other_side(self, sched: dict, ctx: dict) -> str | None:
        """The side that did NOT propose — i.e. who is allowed to confirm."""
        proposer_team = sched.get('proposed_by_team')
        if ctx['home'] and ctx['home']['team_id'] == proposer_team:
            return 'away'
        if ctx['away'] and ctx['away']['team_id'] == proposer_team:
            return 'home'
        return None

    async def _on_confirm(self, interaction: discord.Interaction):
        db, ctx, sched = self._load()
        if not ctx or not sched or sched.get('status') != 'proposed':
            await interaction.response.send_message('There is no active proposal to confirm.', ephemeral=True)
            return

        other = self._other_side(sched, ctx)
        side = _member_side(interaction.user, ctx['home'], ctx['away'])
        if not _is_admin(interaction.user) and side != other:
            await interaction.response.send_message(
                'Only the **other** team can confirm this proposal.', ephemeral=True)
            return

        scheduled = next_occurrence(sched['proposed_day'], sched['proposed_time'])
        db.match_schedules.set_confirmed(self.match_id, scheduled.replace(tzinfo=None))

        unix = int(scheduled.timestamp())
        embed = discord.Embed(
            title='✅ Match Scheduled',
            description=f'This match is locked in for <t:{unix}:F> (<t:{unix}:R>).\n'
                        'Need to change it? Use **🔁 Reschedule** below — both teams must agree.',
            color=discord.Color.green(),
        )
        await interaction.response.edit_message(content=None, embed=embed, view=RescheduleView(self.match_id))
        await _refresh_launchpad()

    async def _on_counter(self, interaction: discord.Interaction):
        db, ctx, sched = self._load()
        if not ctx or not sched or sched.get('status') != 'proposed':
            await interaction.response.send_message('There is no active proposal to counter.', ephemeral=True)
            return

        other = self._other_side(sched, ctx)
        side = _member_side(interaction.user, ctx['home'], ctx['away'])
        if not _is_admin(interaction.user) and side != other:
            await interaction.response.send_message(
                'Only the **other** team can counter-propose.', ephemeral=True)
            return

        # The counter-proposer's side: their own team (or the awaiting side for an admin).
        proposer_side = side if side in ('home', 'away') else other
        view = ProposeView(self.match_id, proposer_side)
        await interaction.response.send_message(embed=view.build_embed(), view=view, ephemeral=True)


# ── Entry button (persistent, pinned in the match channel) ───

class MatchScheduleButtonView(View):
    """Persistent 'Propose Match Time' button pinned in each match channel."""

    def __init__(self, match_id: int):
        super().__init__(timeout=None)
        self.match_id = match_id
        btn = Button(label='📅 Propose Match Time', style=discord.ButtonStyle.primary,
                     custom_id=f'match_sched_propose_{match_id}')
        btn.callback = self._callback
        self.add_item(btn)

    async def _callback(self, interaction: discord.Interaction):
        # Works for both initial scheduling and rescheduling a confirmed match.
        await _open_propose(interaction, self.match_id)


def register_match_schedule_views(bot, db):
    """Re-register persistent match-scheduling views so buttons survive restarts."""
    if not db:
        return
    for sched in db.match_schedules.get_all():
        match_id = sched['match_id']
        bot.add_view(MatchScheduleButtonView(match_id))
        bot.add_view(RescheduleView(match_id))
        if sched.get('status') == 'proposed':
            bot.add_view(ProposalDecisionView(match_id))
