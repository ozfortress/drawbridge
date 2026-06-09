"""Discord UI for team scheduling availability."""

import discord
from discord.ui import View, Button, Select

DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
DAY_EMOJIS = ['🇲', '🇹', '🇼', '🇹', '🇫', '🇸', '🇸']
TIME_LABELS = {'19:00': '7:00 PM', '20:00': '8:00 PM', '21:00': '9:00 PM'}


class ScheduleDaySelect(Select):
    """Multi-select for days of the week."""

    def __init__(self, excluded_days: set[int], selected: set[int]):
        options = []
        for d in range(7):
            if d in excluded_days:
                continue
            options.append(discord.SelectOption(
                label=DAY_NAMES[d],
                value=str(d),
                default=d in selected,
            ))
        super().__init__(
            placeholder='Select days…',
            options=options,
            min_values=0, max_values=len(options) if options else 1,
            custom_id='sched_days',
        )

    async def callback(self, interaction: discord.Interaction):
        view: ScheduleEditView = self.view
        view._selected_days = set(int(v) for v in self.values)
        embed = view._build_embed()
        await interaction.response.edit_message(embed=embed, view=view)


class ScheduleTimeSelect(Select):
    """Multi-select for time slots."""

    def __init__(self, selected: set[str]):
        options = [
            discord.SelectOption(label=TIME_LABELS[t], value=t, default=t in selected)
            for t in ['19:00', '20:00', '21:00']
        ]
        super().__init__(
            placeholder='Select times…',
            options=options,
            min_values=0, max_values=3,
            custom_id='sched_times',
        )

    async def callback(self, interaction: discord.Interaction):
        view: ScheduleEditView = self.view
        view._selected_times = set(self.values)
        embed = view._build_embed()
        await interaction.response.edit_message(embed=embed, view=view)


class ScheduleEditView(View):
    """Transient view for the nested availability editor with navigation pages."""

    PAGE_DAYS = 0
    PAGE_TIMES = 1
    PAGE_REVIEW = 2

    def __init__(self, team_id: int, league_id: int,
                 excluded_days_str: str | None,
                 current: list[dict] | None):
        super().__init__(timeout=300)
        self._team_id = team_id
        self._league_id = league_id
        self._excluded: set[int] = set()
        if excluded_days_str:
            self._excluded = set(int(x) for x in excluded_days_str.split(',') if x.strip())
        self._selected_days: set[int] = set()
        self._selected_times: set[str] = set()
        self._page = self.PAGE_DAYS

        if current:
            for row in current:
                self._selected_days.add(row['day_of_week'])
                self._selected_times.add(row['time_slot'])

        self._build()

    def _build(self):
        self.clear_items()
        if self._page == self.PAGE_DAYS:
            self.add_item(ScheduleDaySelect(self._excluded, self._selected_days))
            self.add_item(Button(label='Next →', style=discord.ButtonStyle.primary,
                                 custom_id='sched_next_days', row=1))
        elif self._page == self.PAGE_TIMES:
            btn_back = Button(label='← Days', style=discord.ButtonStyle.secondary,
                              custom_id='sched_back_times', row=1)
            btn_back.callback = self._go_days
            self.add_item(btn_back)
            self.add_item(ScheduleTimeSelect(self._selected_times))
            self.add_item(Button(label='Next →', style=discord.ButtonStyle.primary,
                                 custom_id='sched_next_times', row=2))
        elif self._page == self.PAGE_REVIEW:
            btn_back = Button(label='← Times', style=discord.ButtonStyle.secondary,
                              custom_id='sched_back_review', row=1)
            btn_back.callback = self._go_times
            self.add_item(btn_back)
            btn_save = Button(label='💾 Save', style=discord.ButtonStyle.success,
                              custom_id='sched_save', row=2)
            btn_save.callback = self._on_save
            self.add_item(btn_save)

        # Wire all items' callbacks
        self._wire_callbacks()

    def _wire_callbacks(self):
        for item in self.children:
            if isinstance(item, Button):
                if item.custom_id == 'sched_next_days':
                    item.callback = self._go_times
                elif item.custom_id == 'sched_next_times':
                    item.callback = self._go_review
                elif item.custom_id == 'sched_save':
                    item.callback = self._on_save
                elif item.custom_id == 'sched_back_times' or item.custom_id == 'sched_back_review':
                    pass  # already set in _build

    def _build_embed(self) -> discord.Embed:
        if self._page == self.PAGE_DAYS:
            e = discord.Embed(
                title='📅 Select Days',
                description='Pick the days your team is available to play.\nNavigate with the button below.',
                color=discord.Color.blue(),
            )
            days_str = ', '.join(sorted(DAY_NAMES[d] for d in self._selected_days)) if self._selected_days else 'None selected'
            e.add_field(name='Currently selected', value=days_str, inline=False)
            if self._excluded:
                excluded_names = [DAY_NAMES[d] for d in sorted(self._excluded)]
                e.add_field(name='Excluded days', value=', '.join(excluded_names), inline=False)
        elif self._page == self.PAGE_TIMES:
            e = discord.Embed(
                title='🕐 Select Times',
                description='Pick the times your team is available.\nDefault options are 7pm, 8pm, 9pm.',
                color=discord.Color.blue(),
            )
            if self._selected_days:
                e.add_field(name='Selected days',
                            value=', '.join(sorted(DAY_NAMES[d] for d in self._selected_days)),
                            inline=False)
            times_str = ', '.join(sorted(TIME_LABELS[t] for t in self._selected_times)) if self._selected_times else 'None selected'
            e.add_field(name='Currently selected', value=times_str, inline=False)
        elif self._page == self.PAGE_REVIEW:
            e = discord.Embed(
                title='📋 Review Your Availability',
                description='Confirm your team\'s availability below.',
                color=discord.Color.green(),
            )
            if self._selected_days:
                day_lines = []
                for d in sorted(self._selected_days):
                    times_for_day = sorted(self._selected_times) if self._selected_times else ['—']
                    day_lines.append(f'{DAY_EMOJIS[d]} **{DAY_NAMES[d]}**: {", ".join(TIME_LABELS[t] for t in times_for_day)}')
                e.add_field(name='Schedule', value='\n'.join(day_lines), inline=False)
            else:
                e.add_field(name='Schedule', value='No days selected', inline=False)
        return e

    async def _go_times(self, interaction: discord.Interaction):
        if not self._selected_days:
            await interaction.response.send_message('Please select at least one day first.', ephemeral=True)
            return
        self._page = self.PAGE_TIMES
        self._build()
        embed = self._build_embed()
        await interaction.response.edit_message(embed=embed, view=self)

    async def _go_review(self, interaction: discord.Interaction):
        self._page = self.PAGE_REVIEW
        self._build()
        embed = self._build_embed()
        await interaction.response.edit_message(embed=embed, view=self)

    async def _go_days(self, interaction: discord.Interaction):
        self._page = self.PAGE_DAYS
        self._build()
        embed = self._build_embed()
        await interaction.response.edit_message(embed=embed, view=self)

    async def _on_save(self, interaction: discord.Interaction):
        from web.admin_panel import _db
        if not _db:
            await interaction.response.send_message('Database not ready.', ephemeral=True)
            return
        slots = []
        for d in self._selected_days:
            for t in self._selected_times:
                slots.append((d, t))
        _db.team_availability.set_availability(self._team_id, self._league_id, slots)

        self.clear_items()
        done = discord.Embed(
            title='✅ Availability Saved!',
            description='Your team\'s availability has been recorded.',
            color=discord.Color.green(),
        )
        if slots:
            day_lines = []
            for d in sorted(self._selected_days):
                times_for_day = [TIME_LABELS[t] for t in sorted(self._selected_times)]
                day_lines.append(f'{DAY_EMOJIS[d]} **{DAY_NAMES[d]}**: {", ".join(times_for_day)}')
            done.add_field(name='Saved Schedule', value='\n'.join(day_lines), inline=False)
        else:
            done.add_field(name='Saved Schedule', value='No availability set', inline=False)
        await interaction.response.edit_message(embed=done, view=None)


class ScheduleButtonView(View):
    """Persistent button pinned in team channels to open the schedule editor."""

    def __init__(self, team_id: int, league_id: int):
        super().__init__(timeout=None)
        self._team_id = team_id
        self._league_id = league_id
        btn = Button(label='📅 Set Availability', style=discord.ButtonStyle.primary,
                     custom_id=f'sched_btn_{team_id}_{league_id}')
        btn.callback = self._callback
        self.add_item(btn)

    async def _callback(self, interaction: discord.Interaction):
        from web.admin_panel import _db
        if not _db:
            await interaction.response.send_message('Database not ready.', ephemeral=True)
            return
        settings = _db.tournament_schedule_settings.get_by_league(self._league_id)
        excluded = settings['excluded_days'] if settings else None
        current = _db.team_availability.get_by_team(self._team_id, self._league_id)

        embed = discord.Embed(
            title='📅 Team Availability',
            description='Use the navigation below to set your availability.',
            color=discord.Color.blue(),
        )
        view = ScheduleEditView(self._team_id, self._league_id, excluded, current)
        embed = view._build_embed()
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)


def register_schedule_views(bot, db):
    """Register persistent schedule buttons for all active leagues."""
    if not db:
        return
    leagues = db.leagues.get_all()
    for league in leagues:
        teams = db.teams.get_by_league(league['id'])
        for team in teams:
            bot.add_view(ScheduleButtonView(team['team_id'], league['id']))
