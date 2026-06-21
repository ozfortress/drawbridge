"""Discord UI for per-match scheduling (propose / confirm / counter-propose).

This sits on top of the team-availability feature in ``schedule_discord.py``.
Each generated match (in a scheduling-enabled league) gets a pinned "Propose
Match Time" button. One captain proposes a day + time, the other team confirms
or counter-proposes. Once confirmed, the agreed time is stored and shown to
everyone as a Discord dynamic timestamp.
"""

import datetime
from zoneinfo import ZoneInfo

import discord
from discord.ui import View, Button, Select

from web.schedule_discord import DAY_NAMES, TIME_LABELS
from modules.Drawbridge.checks import Checks

SYDNEY = ZoneInfo('Australia/Sydney')
_checks = Checks()


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


def _slot_label(day: int, time_str: str) -> str:
    return f'{DAY_NAMES[day]} {TIME_LABELS.get(time_str, time_str)}'


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
            discord.SelectOption(label=TIME_LABELS[t], value=t, default=(t == selected))
            for t in ('19:00', '20:00', '21:00')
        ]
        super().__init__(placeholder='Pick a time…', options=options,
                         min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        view: ProposeView = self.view
        view.time = self.values[0]
        await interaction.response.edit_message(embed=view.build_embed(), view=view)


class ProposeView(View):
    """Ephemeral editor a captain uses to choose a day + time to propose."""

    def __init__(self, match_id: int, proposer_side: str):
        super().__init__(timeout=300)
        self.match_id = match_id
        self.proposer_side = proposer_side  # 'home' | 'away'
        self.day: int | None = None
        self.time: str | None = None

        db = _get_db()
        ctx = _resolve_context(db, match_id) if db else None
        settings = ctx['settings'] if ctx else None
        self.add_item(_DaySelect(_playable_days(settings), self.day))
        self.add_item(_TimeSelect(self.time))
        send = Button(label='Send Proposal', style=discord.ButtonStyle.success, row=2)
        send.callback = self._on_send
        self.add_item(send)

    def build_embed(self) -> discord.Embed:
        e = discord.Embed(
            title='📅 Propose a Match Time',
            description='Pick a day and time, then **Send Proposal**. The other '
                        'team will be asked to confirm or counter-propose.',
            color=discord.Color.blurple(),
        )
        chosen = _slot_label(self.day, self.time) if (self.day is not None and self.time) else 'Nothing selected yet'
        e.add_field(name='Your proposal', value=chosen, inline=False)
        e.add_field(
            name='Note', inline=False,
            value='Times are AEST/AEDT. Days outside the listed range need an '
                  'admin to approve — ping an admin in the channel.',
        )
        return e

    async def _on_send(self, interaction: discord.Interaction):
        if self.day is None or self.day < 0 or not self.time:
            await interaction.response.send_message(
                'Pick a valid day and time first. (If no days are available, an admin '
                'needs to adjust this league\'s excluded days.)', ephemeral=True)
            return
        db = _get_db()
        ctx = _resolve_context(db, self.match_id) if db else None
        if not ctx:
            await interaction.response.send_message('This match is no longer being scheduled.', ephemeral=True)
            return

        proposer = ctx[self.proposer_side]
        other = ctx['away' if self.proposer_side == 'home' else 'home']
        db.match_schedules.set_proposal(
            self.match_id, self.day, self.time,
            proposer['team_id'] if proposer else None, interaction.user.id,
        )

        embed = discord.Embed(
            title='📅 Proposed Match Time',
            description=f"**{proposer['team_name'] if proposer else 'A team'}** proposed "
                        f"**{_slot_label(self.day, self.time)}**.",
            color=discord.Color.gold(),
        )
        embed.add_field(
            name='Next step',
            value='The other team can **Confirm** to lock it in, or **Counter-propose** a different time.',
            inline=False,
        )
        mention = f"<@&{other['role_id']}>" if other and other.get('role_id') else ''
        await interaction.response.edit_message(
            content='✅ Proposal sent.', embed=None, view=None,
        )
        await interaction.channel.send(
            content=mention or None,
            embed=embed,
            view=ProposalDecisionView(self.match_id),
            allowed_mentions=discord.AllowedMentions(roles=True),
        )


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
            description=f'This match is locked in for <t:{unix}:F> (<t:{unix}:R>).',
            color=discord.Color.green(),
        )
        await interaction.response.edit_message(content=None, embed=embed, view=None)
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
        db = _get_db()
        ctx = _resolve_context(db, self.match_id) if db else None
        if not ctx:
            await interaction.response.send_message('Scheduling is not active for this match.', ephemeral=True)
            return

        side = _member_side(interaction.user, ctx['home'], ctx['away'])
        if side is None:
            await interaction.response.send_message(
                'Only a member of one of the competing teams can propose a time.', ephemeral=True)
            return

        sched = db.match_schedules.get_by_match_id(self.match_id)
        if sched and sched.get('status') == 'confirmed':
            unix = int(sched['scheduled_at'].replace(tzinfo=datetime.timezone.utc).timestamp())
            await interaction.response.send_message(
                f'This match is already scheduled for <t:{unix}:F>. Ping an admin to change it.',
                ephemeral=True)
            return

        view = ProposeView(self.match_id, side)
        await interaction.response.send_message(embed=view.build_embed(), view=view, ephemeral=True)


def register_match_schedule_views(bot, db):
    """Re-register persistent match-scheduling views so buttons survive restarts."""
    if not db:
        return
    for sched in db.match_schedules.get_all():
        match_id = sched['match_id']
        bot.add_view(MatchScheduleButtonView(match_id))
        if sched.get('status') == 'proposed':
            bot.add_view(ProposalDecisionView(match_id))
