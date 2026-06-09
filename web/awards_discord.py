"""Discord UI components (modals, views) for the awards nomination & voting system."""

import discord
from discord import TextStyle
from discord.ui import Modal, TextInput, View, Button

# In-memory session store for modal chaining
# Key: f"{interaction.user.id}:{event_id}" -> dict
_sessions: dict[str, dict] = {}


def _session_key(user_id: int, event_id: int) -> str:
    return f"{user_id}:{event_id}"


# ── Persistent Views (dynamic custom_ids) ────────────────────


class AwardsNominationsView(View):
    """Button for captains to submit/edit nominations."""

    def __init__(self, event_id: int, team_id: int):
        super().__init__(timeout=None)
        self._event_id = event_id
        self._team_id = team_id
        custom_id = f'awards_nom_{event_id}_{team_id}'
        btn = discord.ui.Button(label='📝 Submit Nominations', custom_id=custom_id, style=discord.ButtonStyle.primary)
        btn.callback = self._button_callback
        self.add_item(btn)

    async def _button_callback(self, interaction: discord.Interaction):
        await handle_nominate_button(interaction, self._event_id, self._team_id)


class AwardsVotesView(View):
    """Button for captains to submit/edit votes."""

    def __init__(self, event_id: int, team_id: int):
        super().__init__(timeout=None)
        self._event_id = event_id
        self._team_id = team_id
        custom_id = f'awards_vote_{event_id}_{team_id}'
        btn = discord.ui.Button(label='🗳️ Submit Votes', custom_id=custom_id, style=discord.ButtonStyle.primary)
        btn.callback = self._button_callback
        self.add_item(btn)

    async def _button_callback(self, interaction: discord.Interaction):
        await handle_vote_button(interaction, self._event_id, self._team_id)


# ── Continue button (transient, not persistent) ──────────────


class ContinueNominationView(View):
    """Transient view with a button to open the next nomination page."""

    def __init__(self, event_id: int, team_id: int, categories: list,
                 page: int, page_size: int, existing: list | None):
        super().__init__(timeout=300)
        self._event_id = event_id
        self._team_id = team_id
        self._categories = categories
        self._page = page
        self._page_size = page_size
        self._existing = existing
        total = max(1, (len(categories) + page_size - 1) // page_size)
        btn = Button(label=f'Continue to Page {page + 1}/{total}', style=discord.ButtonStyle.primary)
        btn.callback = self._callback
        self.add_item(btn)

    async def _callback(self, interaction: discord.Interaction):
        modal = build_nomination_modal(self._event_id, self._team_id,
                                       self._categories, self._page,
                                       self._page_size, self._existing)
        await interaction.response.send_modal(modal)


class ContinueVoteView(View):
    """Transient view with a button to open the next voting page."""

    def __init__(self, event_id: int, team_id: int, categories: list,
                 current_index: int, division_id: int,
                 existing_data: dict | None, nominees_by_cat: dict | None):
        super().__init__(timeout=300)
        self._event_id = event_id
        self._team_id = team_id
        self._categories = categories
        self._current_index = current_index
        self._division_id = division_id
        self._existing_data = existing_data
        self._nominees_by_cat = nominees_by_cat
        total = len(categories)
        btn = Button(label=f'Continue to Category {current_index + 1}/{total}',
                     style=discord.ButtonStyle.primary)
        btn.callback = self._callback
        self.add_item(btn)

    async def _callback(self, interaction: discord.Interaction):
        modal = build_vote_modal(self._event_id, self._team_id,
                                 self._categories, self._current_index,
                                 self._division_id, self._existing_data,
                                 self._nominees_by_cat)
        await interaction.response.send_modal(modal)


# ── Nomination Modals ─────────────────────────────────────────


def build_nomination_modal(event_id: int, team_id: int, categories: list,
                           page: int, page_size: int = 5, existing: list = None) -> Modal:
    """Build a modal for a page of nomination categories."""
    start = page * page_size
    end = min(start + page_size, len(categories))
    page_cats = categories[start:end]
    total_pages = max(1, (len(categories) + page_size - 1) // page_size)
    existing_map = {}
    if existing:
        for e in existing:
            existing_map[e['category_id']] = e['response']

    title = f"🏆 Nominations ({page + 1}/{total_pages})"
    modal = Modal(title=title)

    for cat in page_cats:
        default_val = existing_map.get(cat['id'], '')
        text_input = TextInput(
            label=cat['name'][:45],
            default=default_val,
            style=TextStyle.short,
            required=True,
            max_length=100,
            custom_id=f"nom_{cat['id']}",
        )
        modal.add_item(text_input)

    is_last = (end >= len(categories))

    async def on_submit(interaction: discord.Interaction):
        page_data = {}
        for item in modal.children:
            if isinstance(item, TextInput) and item.custom_id and item.custom_id.startswith('nom_'):
                cat_id = int(item.custom_id.replace('nom_', ''))
                page_data[cat_id] = item.value.strip()

        skey = _session_key(interaction.user.id, event_id)
        if skey not in _sessions:
            _sessions[skey] = {'event_id': event_id, 'team_id': team_id, 'nominations': {}}
        _sessions[skey]['nominations'].update(page_data)
        _sessions[skey]['page'] = page

        if is_last:
            await _finalize_nominations(interaction, event_id, team_id,
                                        categories, _sessions[skey]['nominations'])
            _sessions.pop(skey, None)
        else:
            await interaction.response.send_message(
                f"Page {page + 1} saved! Click below for the next page.",
                view=ContinueNominationView(event_id, team_id, categories,
                                            page + 1, page_size, existing),
                ephemeral=True
            )

    modal.on_submit = on_submit
    return modal


async def handle_nominate_button(interaction: discord.Interaction, event_id: int, team_id: int):
    """Handle the nominate button click — start or resume nomination flow."""
    from web.admin_panel import _db
    event = _db.award_events.get_by_id(event_id) if _db else None
    if not event or event['status'] not in ('nominations',):
        await interaction.response.send_message('Nominations are not currently open for this event.', ephemeral=True)
        return

    categories = _db.award_event_categories.get_by_event_and_fill_types(event_id, ['nomination'])
    if not categories:
        await interaction.response.send_message('No nomination categories configured.', ephemeral=True)
        return

    existing = _db.award_nominations.get_by_team_and_event(team_id, event_id)

    modal = build_nomination_modal(event_id, team_id, categories, page=0, existing=existing)
    await interaction.response.send_modal(modal)


async def _finalize_nominations(interaction: discord.Interaction, event_id: int,
                                 team_id: int, categories: list, responses: dict):
    """Save all nominations to the database."""
    from web.admin_panel import _db, logger
    saved = 0
    for cat in categories:
        response = responses.get(cat['id'], '')
        if not response:
            continue
        try:
            existing = _db.award_nominations.get_by_team_and_category(team_id, cat['id'])
            if existing:
                _db.award_nominations.update(existing['id'], {
                    'response': response,
                    'status': 'accepted',
                    'submitted_by': interaction.user.id,
                })
            else:
                team = _db.teams.get_by_team_id(team_id)
                division_id = team['division'] if team else 0
                _db.award_nominations.insert({
                    'event_id': event_id,
                    'category_id': cat['id'],
                    'team_id': team_id,
                    'division_id': division_id,
                    'submitted_by': interaction.user.id,
                    'response': response,
                    'status': 'accepted',
                })
            saved += 1
        except Exception as e:
            logger.error(f'Failed to save nomination: {e}')

    msg = f'✅ Nominations submitted! ({saved}/{len(categories)} categories)'
    await interaction.response.send_message(msg, ephemeral=True)


# ── Voting (Dropdowns) ─────────────────────────────────────────


def _nominees_to_options(nominees: list[str]) -> list[discord.SelectOption]:
    """Convert a nominee list to Discord select options (max 25)."""
    return [
        discord.SelectOption(label=n[:100], value=n[:100])
        for n in nominees[:25]
    ]


class VotePreferenceSelect(discord.ui.Select):
    """A select that records one preference and advances to the next."""

    def __init__(self, placeholder: str, options: list[discord.SelectOption],
                 pref_num: int, cat_name: str, color: discord.Color):
        super().__init__(
            placeholder=placeholder,
            options=options,
            min_values=1, max_values=1,
            custom_id=f'vp_{pref_num}',
        )
        self._pref_num = pref_num
        self._cat_name = cat_name
        self._color = color

    async def callback(self, interaction: discord.Interaction):
        view: VoteCategoryView = self.view
        choice = self.values[0]
        # Store choice
        if self._pref_num == 1:
            view._choice_1 = choice
        elif self._pref_num == 2:
            view._choice_2 = choice
        elif self._pref_num == 3:
            view._choice_3 = choice
        await view._advance(interaction)


class VoteCategoryView(View):
    """Collects 1st/2nd/3rd preferences for one category via sequential selects."""

    def __init__(self, event_id: int, team_id: int, division_id: int,
                 cat: dict, nominees: list[str],
                 existing: dict | None, color: discord.Color,
                 cat_index: int, total_cats: int,
                 all_categories: list[dict],
                 categories_remaining: list[dict],
                 nominees_by_cat: dict[int, list[str]],
                 existing_data: dict):
        super().__init__(timeout=300)
        self._event_id = event_id
        self._team_id = team_id
        self._division_id = division_id
        self._cat = cat
        self._nominees = nominees
        self._existing = existing or {}
        self._color = color
        self._cat_index = cat_index
        self._total_cats = total_cats
        self._all_categories = all_categories
        self._categories_remaining = categories_remaining
        self._nominees_by_cat = nominees_by_cat
        self._existing_data = existing_data
        self._choice_1: str | None = None
        self._choice_2: str | None = None
        self._choice_3: str | None = None

    def _remaining_options(self) -> list[discord.SelectOption]:
        exclude = {self._choice_1, self._choice_2, self._choice_3}
        remaining = [n for n in self._nominees if n not in exclude]
        return _nominees_to_options(remaining)

    def _embed(self, title: str, description: str) -> discord.Embed:
        e = discord.Embed(title=title, description=description, color=self._color)
        if self._choice_1:
            e.add_field(name='1st Preference', value=self._choice_1, inline=False)
        if self._choice_2:
            e.add_field(name='2nd Preference', value=self._choice_2, inline=False)
        if self._choice_3:
            e.add_field(name='3rd Preference', value=self._choice_3, inline=False)
        return e

    async def _send_initial(self, interaction: discord.Interaction, edit: bool = False):
        cat = self._cat
        desc = f'Category {self._cat_index + 1} of {self._total_cats}\nSelect your **1st Preference** from the dropdown below.'
        embed = self._embed(f'🗳️ {cat["name"]}', desc)
        options = _nominees_to_options(self._nominees)
        select = VotePreferenceSelect('Choose 1st Preference…', options, 1, cat['name'], self._color)
        self.clear_items()
        self.add_item(select)

        if edit:
            await interaction.response.edit_message(embed=embed, view=self)
        else:
            await interaction.response.send_message(embed=embed, view=self, ephemeral=True)

    async def _advance(self, interaction: discord.Interaction):
        cat = self._cat
        if not self._choice_2 and self._choice_1:
            # Ask for 2nd
            desc = f'Category {self._cat_index + 1} of {self._total_cats}\nYour 1st choice: **{self._choice_1}**\nSelect your **2nd Preference** from the remaining options.'
            embed = self._embed(f'🗳️ {cat["name"]}', desc)
            remaining = self._remaining_options()
            if not remaining:
                # No options left for 2nd/3rd — skip to confirm
                self._choice_2 = ''
                await self._show_confirm(interaction)
                return
            select = VotePreferenceSelect('Choose 2nd Preference…', remaining, 2, cat['name'], self._color)
            self.clear_items()
            self.add_item(select)
            await interaction.response.edit_message(embed=embed, view=self)

        elif not self._choice_3 and self._choice_2 is not None:
            # Ask for 3rd
            desc = f'Category {self._cat_index + 1} of {self._total_cats}\n1st: **{self._choice_1}**\n2nd: **{self._choice_2}**\nSelect your **3rd Preference** from the remaining options.'
            embed = self._embed(f'🗳️ {cat["name"]}', desc)
            remaining = self._remaining_options()
            if not remaining:
                self._choice_3 = ''
                await self._show_confirm(interaction)
                return
            select = VotePreferenceSelect('Choose 3rd Preference…', remaining, 3, cat['name'], self._color)
            self.clear_items()
            self.add_item(select)
            await interaction.response.edit_message(embed=embed, view=self)

        else:
            await self._show_confirm(interaction)

    async def _show_confirm(self, interaction: discord.Interaction):
        desc = f'Category {self._cat_index + 1} of {self._total_cats}\nConfirm your votes or click **Change**.'
        embed = self._embed(f'🗳️ {self._cat["name"]}', desc)
        self.clear_items()
        confirm = Button(label='✅ Confirm & Continue', style=discord.ButtonStyle.success, custom_id='vc_confirm')
        change = Button(label='🔄 Change', style=discord.ButtonStyle.secondary, custom_id='vc_change')
        confirm.callback = self._on_confirm
        change.callback = self._on_change
        self.add_item(confirm)
        self.add_item(change)
        await interaction.response.edit_message(embed=embed, view=self)

    async def _on_confirm(self, interaction: discord.Interaction):
        # Save to session
        skey = _session_key(interaction.user.id, self._event_id)
        if skey not in _sessions:
            _sessions[skey] = {'event_id': self._event_id, 'team_id': self._team_id, 'votes': {}}
        _sessions[skey]['votes'][self._cat['id']] = {
            'choice_1': self._choice_1 or '',
            'choice_2': self._choice_2 or '',
            'choice_3': self._choice_3 or '',
        }

        remaining = self._categories_remaining
        if remaining:
            # Next category
            next_cat = remaining[0]
            rest = remaining[1:]
            nominees = self._nominees_by_cat.get(next_cat['id'], [])
            existing = self._existing_data.get(next_cat['id'], {})
            idx = self._cat_index + 1
            next_view = VoteCategoryView(
                self._event_id, self._team_id, self._division_id,
                next_cat, nominees, existing, self._color,
                idx, self._total_cats, self._all_categories, rest,
                self._nominees_by_cat, self._existing_data,
            )
            await next_view._send_initial(interaction, edit=True)
        else:
            # All done — finalize
            saved = await _finalize_votes(self._event_id, self._team_id,
                                          self._division_id,
                                          self._all_categories,
                                          _sessions[skey]['votes'])
            _sessions.pop(skey, None)
            embed = discord.Embed(
                title='✅ Votes Submitted!',
                description=f'({saved}/{self._total_cats} categories)',
                color=discord.Color.green(),
            )
            await interaction.response.edit_message(embed=embed, view=None)

    async def _on_change(self, interaction: discord.Interaction):
        self._choice_2 = None
        self._choice_3 = None
        await self._send_initial(interaction, edit=True)


async def handle_vote_button(interaction: discord.Interaction, event_id: int, team_id: int):
    """Handle the vote button click — start voting flow via dropdowns."""
    from web.admin_panel import _db
    event = _db.award_events.get_by_id(event_id) if _db else None
    if not event or event['status'] not in ('voting',):
        await interaction.response.send_message('Voting is not currently open for this event.', ephemeral=True)
        return

    categories = _db.award_event_categories.get_by_event(event_id)
    if not categories:
        await interaction.response.send_message('No categories configured for voting.', ephemeral=True)
        return

    team = _db.teams.get_by_team_id(team_id)
    division_id = team['division'] if team else 0

    fill_options = _db.award_admin_fill_options.get_by_event(event_id) if hasattr(_db, 'award_admin_fill_options') else []
    fill_opts_by_cat: dict[int, list[str]] = {}
    for fo in fill_options:
        fill_opts_by_cat.setdefault(fo['category_id'], []).append(fo['option'])

    nominees_by_cat = {}
    for cat in categories:
        if cat['fill_type'] == 'admin_fill':
            nominees = fill_opts_by_cat.get(cat['id'], [])
        elif cat['fill_type'] == 'autofill_team':
            teams_in_div = _db.teams.get_by_division(division_id)
            nominees = [t['team_name'] for t in teams_in_div]
        else:
            nominees = _db.award_nominations.distinct_responses(event_id, cat['id'])
        nominees_by_cat[cat['id']] = nominees

    existing_votes = _db.award_votes.get_by_team_and_event(team_id, event_id)
    existing_data = {}
    if existing_votes:
        for ev in existing_votes:
            existing_data[ev['category_id']] = {
                'choice_1': ev.get('choice_1', ''),
                'choice_2': ev.get('choice_2', ''),
                'choice_3': ev.get('choice_3', ''),
            }

    nom_cats = [c for c in categories if c['fill_type'] == 'nomination']
    if nom_cats:
        has_noms = _db.award_nominations.has_team_submitted_all(
            team_id, event_id, [c['id'] for c in nom_cats]
        )
        if not has_noms:
            await interaction.response.send_message(
                'Your team did not complete nominations, so you cannot vote. '
                'Contact an admin if you believe this is an error.', ephemeral=True
            )
            return

    first_cat = categories[0]
    remaining = categories[1:]
    nominees = nominees_by_cat.get(first_cat['id'], [])
    existing = existing_data.get(first_cat['id'], {})
    color = discord.Color.blue()
    total = len(categories)

    view = VoteCategoryView(
        event_id, team_id, division_id,
        first_cat, nominees, existing, color,
        0, total, categories, remaining,
        nominees_by_cat, existing_data,
    )
    await view._send_initial(interaction, edit=False)


async def _finalize_votes(event_id: int, team_id: int, division_id: int,
                           categories: list, vote_data: dict) -> int:
    """Save all votes to the database, returns (saved, total)."""
    from web.admin_panel import _db, logger
    saved = 0
    for cat in categories:
        vd = vote_data.get(cat['id'], {})
        choice_1 = vd.get('choice_1', '')
        if not choice_1:
            continue
        try:
            existing = _db.award_votes.get_by_team_and_category(team_id, cat['id'])
            if existing:
                _db.award_votes.update(existing['id'], {
                    'choice_1': choice_1,
                    'choice_2': vd.get('choice_2', ''),
                    'choice_3': vd.get('choice_3', ''),
                    'status': 'accepted',
                })
            else:
                _db.award_votes.insert({
                    'event_id': event_id,
                    'category_id': cat['id'],
                    'team_id': team_id,
                    'division_id': division_id,
                    'choice_1': choice_1,
                    'choice_2': vd.get('choice_2', ''),
                    'choice_3': vd.get('choice_3', ''),
                    'status': 'accepted',
                })
            saved += 1
        except Exception as e:
            logger.error(f'Failed to save vote: {e}')
    return saved


# ── Helper functions for sending messages ─────────────────────


async def send_nomination_message(bot, channel_id: int, role_id: int,
                                   event_id: int, team_id: int):
    """Send nomination prompt to a team channel."""
    channel = bot.get_channel(channel_id)
    if not channel:
        return False
    try:
        view = AwardsNominationsView(event_id, team_id)
        await channel.send(
            f'<@&{role_id}> \U0001f4e2 **Award Nominations are now open!**\n'
            f'Click the button below to submit your team\'s nominations.\n'
            f'You can edit your responses by clicking again before nominations close.',
            view=view
        )
        return True
    except Exception:
        return False


async def send_vote_message(bot, channel_id: int, role_id: int,
                             event_id: int, team_id: int):
    """Send voting prompt to a team channel."""
    channel = bot.get_channel(channel_id)
    if not channel:
        return False
    try:
        view = AwardsVotesView(event_id, team_id)
        await channel.send(
            f'<@&{role_id}> \U0001f5f3\ufe0f **Voting is now open!**\n'
            f'Click the button below to cast your team\'s votes.\n'
            f'You have one ballot per team. You can edit by clicking again before voting closes.',
            view=view
        )
        return True
    except Exception:
        return False


async def send_invalidation_notification(bot, channel_id: int, role_id: int,
                                          submission_type: str, reason: str = None):
    """Notify team that their submission was invalidated."""
    channel = bot.get_channel(channel_id)
    if not channel:
        return False
    try:
        text = f'<@&{role_id}> \u26a0\ufe0f Your **{submission_type}** has been flagged by an admin.'
        if reason:
            text += f'\n**Reason:** {reason}'
        text += '\nPlease resubmit using the button below.'
        await channel.send(text)
        return True
    except Exception:
        return False


def register_views(bot, db):
    """Register persistent views with the bot (call once at startup)."""
    if not db:
        return
    events = db.award_events.get_all()
    for event in events:
        if event['status'] in ('nominations', 'voting'):
            teams = db.teams.get_by_league(event['league_id'])
            for team in teams:
                if event['status'] == 'nominations':
                    bot.add_view(AwardsNominationsView(event['id'], team['team_id']))
                elif event['status'] == 'voting':
                    bot.add_view(AwardsVotesView(event['id'], team['team_id']))
