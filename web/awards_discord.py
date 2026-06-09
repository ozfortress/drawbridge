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


# ── Voting (Persistent per-category messages) ──────────────────


def _nominees_to_options(nominees: list[str]) -> list[discord.SelectOption]:
    """Convert a nominee list to Discord select options (max 25)."""
    return [
        discord.SelectOption(label=n[:100], value=n[:100])
        for n in nominees[:25]
    ]


class VotePreferenceSelect(discord.ui.Select):
    """One of three preference selects on a category message."""

    def __init__(self, pref_num: int, category_id: int, team_id: int,
                 options: list[discord.SelectOption]):
        super().__init__(
            placeholder={1: '1st Preference…', 2: '2nd Preference…', 3: '3rd Preference…'}[pref_num],
            options=options,
            min_values=1, max_values=1,
            custom_id=f'vsel_{category_id}_{team_id}_{pref_num}',
        )
        self._pref_num = pref_num

    async def callback(self, interaction: discord.Interaction):
        view: VoteCategoryView = self.view
        choice = self.values[0]

        from web.admin_panel import _db

        # Read current DB state (source of truth for concurrent edits)
        db_vote = _db.award_votes.get_by_team_and_category(view._team_id, view._category_id)
        c1 = (db_vote.get('choice_1', '') or '') if db_vote else ''
        c2 = (db_vote.get('choice_2', '') or '') if db_vote else ''
        c3 = (db_vote.get('choice_3', '') or '') if db_vote else ''

        # Check uniqueness against what's already saved in DB
        others = {1: c1, 2: c2, 3: c3}
        others.pop(self._pref_num, None)
        for pref_num, val in others.items():
            if val == choice:
                await interaction.response.send_message(
                    f'**{choice}** is already the {["", "1st", "2nd", "3rd"][pref_num]} preference. Pick someone else.',
                    ephemeral=True,
                )
                return

        # Save to DB immediately so concurrent callbacks see latest state
        data = {'choice_1': c1, 'choice_2': c2, 'choice_3': c3}
        data[f'choice_{self._pref_num}'] = choice
        if db_vote:
            _db.award_votes.update(db_vote['id'], data)
        else:
            team = _db.teams.get_by_team_id(view._team_id)
            division_id = team['division'] if team else 0
            data.update({
                'event_id': view._event_id,
                'category_id': view._category_id,
                'team_id': view._team_id,
                'division_id': division_id,
                'status': 'accepted',
            })
            _db.award_votes.insert(data)

        # Refresh view state from DB after write
        view._choice_1 = data.get('choice_1', '') or ''
        view._choice_2 = data.get('choice_2', '') or ''
        view._choice_3 = data.get('choice_3', '') or ''

        embed = view._build_embed()
        await interaction.response.edit_message(embed=embed, view=view)


class VoteCategoryView(View):
    """Persistent channel message per category with 3 selects + Save button."""

    def __init__(self, event_id: int, team_id: int, cat_name: str,
                 category_id: int, nominees: list[str],
                 choice_1: str = '', choice_2: str = '', choice_3: str = ''):
        super().__init__(timeout=None)
        self._event_id = event_id
        self._team_id = team_id
        self._cat_name = cat_name
        self._category_id = category_id
        self._nominees = nominees
        self._choice_1 = choice_1
        self._choice_2 = choice_2
        self._choice_3 = choice_3
        self._build_items()

    def _build_items(self):
        self.clear_items()
        # For re-registration at startup, use a placeholder so Select isn't empty
        opts = _nominees_to_options(self._nominees) if self._nominees else [discord.SelectOption(label='(placeholder)', value='')]
        for pref in (1, 2, 3):
            self.add_item(VotePreferenceSelect(pref, self._category_id, self._team_id, opts))
        save = Button(label='💾 Save Votes', style=discord.ButtonStyle.success,
                       custom_id=f'vsave_{self._category_id}_{self._team_id}')
        save.callback = self._on_save
        self.add_item(save)

    def _build_embed(self) -> discord.Embed:
        e = discord.Embed(
            title=f'🗳️ {self._cat_name}',
            description='Select your **1st**, **2nd**, and **3rd** preference below, then click **Save Votes**.',
            color=discord.Color.blue(),
        )
        e.add_field(name='1st Preference', value=self._choice_1 or '—', inline=True)
        e.add_field(name='2nd Preference', value=self._choice_2 or '—', inline=True)
        e.add_field(name='3rd Preference', value=self._choice_3 or '—', inline=True)
        if self._nominees:
            nominees_str = '\n'.join(f'• {n}' for n in self._nominees[:30])
            if len(self._nominees) > 30:
                nominees_str += f'\n… and {len(self._nominees) - 30} more'
            e.add_field(name='Valid Nominees', value=nominees_str, inline=False)
        return e

    async def _on_save(self, interaction: discord.Interaction):
        from web.admin_panel import _db, logger

        # Refresh state from DB (important after restart)
        db_vote = _db.award_votes.get_by_team_and_category(self._team_id, self._category_id)
        if db_vote:
            self._choice_1 = db_vote.get('choice_1', '') or ''
            self._choice_2 = db_vote.get('choice_2', '') or ''
            self._choice_3 = db_vote.get('choice_3', '') or ''

        if not self._choice_1:
            await interaction.response.send_message('You must select a 1st Preference before saving.', ephemeral=True)
            return

        non_empty = [c for c in (self._choice_1, self._choice_2, self._choice_3) if c]
        if len(set(non_empty)) != len(non_empty):
            await interaction.response.send_message('All preferences must be different nominees.', ephemeral=True)
            return

        try:
            existing = _db.award_votes.get_by_team_and_category(self._team_id, self._category_id)
            if existing:
                _db.award_votes.update(existing['id'], {
                    'choice_1': self._choice_1,
                    'choice_2': self._choice_2 or '',
                    'choice_3': self._choice_3 or '',
                    'status': 'accepted',
                    'submitted_by': interaction.user.id,
                })
            else:
                team = _db.teams.get_by_team_id(self._team_id)
                division_id = team['division'] if team else 0
                _db.award_votes.insert({
                    'event_id': self._event_id,
                    'category_id': self._category_id,
                    'team_id': self._team_id,
                    'division_id': division_id,
                    'submitted_by': interaction.user.id,
                    'choice_1': self._choice_1,
                    'choice_2': self._choice_2 or '',
                    'choice_3': self._choice_3 or '',
                    'status': 'accepted',
                })

            self.clear_items()
            done = discord.Embed(
                title=f'✅ Votes Saved — {self._cat_name}',
                color=discord.Color.green(),
            )
            done.add_field(name='1st', value=self._choice_1, inline=True)
            done.add_field(name='2nd', value=self._choice_2 or '—', inline=True)
            done.add_field(name='3rd', value=self._choice_3 or '—', inline=True)
            await interaction.response.edit_message(embed=done, view=None)

        except Exception as e:
            logger.error(f'Failed to save vote: {e}')
            await interaction.response.send_message('Failed to save. Please try again.', ephemeral=True)


async def handle_vote_button(interaction: discord.Interaction, event_id: int, team_id: int):
    """Handle the vote button click — send one channel message per category."""
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

    await interaction.response.defer(ephemeral=True)

    sent = 0
    for cat in categories:
        nominees = nominees_by_cat.get(cat['id'], [])
        if not nominees:
            continue

        # Pre-fill from existing vote if any
        c1 = c2 = c3 = ''
        if existing_votes:
            for ev in existing_votes:
                if ev['category_id'] == cat['id']:
                    c1 = ev.get('choice_1', '') or ''
                    c2 = ev.get('choice_2', '') or ''
                    c3 = ev.get('choice_3', '') or ''
                    break

        view = VoteCategoryView(event_id, team_id, cat['name'], cat['id'],
                                nominees, c1, c2, c3)
        embed = view._build_embed()
        await interaction.channel.send(embed=embed, view=view)
        sent += 1

    await interaction.followup.send(f'📬 Posted {sent} category voting messages in {interaction.channel.mention}.')


# ── Helper functions for sending messages ─────────────────────


async def send_nomination_message(bot, channel_id: int, role_id: int,
                                   event_id: int, team_id: int,
                                   categories: list[str] = None):
    """Send nomination prompt to a team channel."""
    channel = bot.get_channel(channel_id)
    if not channel:
        return False
    try:
        text = f'<@&{role_id}> \U0001f4e2 **Award Nominations are now open!**\n'
        if categories:
            text += '\n**Categories to fill in:**\n' + '\n'.join(f'• {c}' for c in categories) + '\n'
        text += '\nClick the button below to submit your team\'s nominations.\n'
        text += 'You can edit your responses by clicking again before nominations close.'
        view = AwardsNominationsView(event_id, team_id)
        await channel.send(text, view=view)
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
                    cats = db.award_event_categories.get_by_event(event['id'])
                    for cat in cats:
                        bot.add_view(VoteCategoryView(
                            event['id'], team['team_id'],
                            cat['name'], cat['id'], [],
                        ))
