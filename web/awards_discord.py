"""Discord UI components (modals, views) for the awards nomination & voting system."""

import discord
from discord import TextStyle
from discord.ui import Modal, TextInput, View

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
            next_modal = build_nomination_modal(event_id, team_id, categories,
                                                page + 1, page_size, existing)
            await interaction.response.send_modal(next_modal)

    modal.on_submit = on_submit
    return modal


async def handle_nominate_button(interaction: discord.Interaction, event_id: int, team_id: int):
    """Handle the nominate button click — start or resume nomination flow."""
    from web.admin_panel import _db
    event = _db.award_events.get_by_id(event_id) if _db else None
    if not event or event['status'] not in ('nominations',):
        await interaction.response.send_message('Nominations are not currently open for this event.', ephemeral=True)
        return

    categories = _db.award_event_categories.get_by_event_and_fill_types(event_id, ['nomination', 'autofill_player'])
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


# ── Voting Modals ──────────────────────────────────────────────


def build_vote_modal(event_id: int, team_id: int, categories: list,
                     current_index: int, division_id: int,
                     existing_data: dict = None, nominees_by_cat: dict = None) -> Modal:
    """Build a modal for voting on one category with 1st/2nd/3rd preferences."""
    cat = categories[current_index]
    total = len(categories)
    title = f"🗳️ Vote: {cat['name']} ({current_index + 1}/{total})"

    modal = Modal(title=title)
    existing = existing_data or {}
    nominees = nominees_by_cat.get(cat['id'], []) if nominees_by_cat else []

    hint = ''
    if nominees:
        hint = f'Pick 3 from: {", ".join(nominees[:10])}'
        if len(nominees) > 10:
            hint += f' and {len(nominees) - 10} more'

    for pref_idx, label in enumerate(['1st Preference', '2nd Preference', '3rd Preference'], 1):
        key = f'choice_{pref_idx}'
        default_val = existing.get(key, '')
        inp = TextInput(
            label=f'{label} ({cat["name"][:30]})',
            default=default_val if default_val else hint if pref_idx == 1 else '',
            style=TextStyle.short,
            required=pref_idx == 1,
            max_length=100,
            custom_id=f'vote_{cat["id"]}_{pref_idx}',
        )
        modal.add_item(inp)

    is_last = (current_index >= total - 1)

    async def on_submit(interaction: discord.Interaction):
        choice_1 = ''
        choice_2 = ''
        choice_3 = ''
        for item in modal.children:
            if isinstance(item, TextInput) and item.custom_id:
                parts = item.custom_id.split('_')
                if len(parts) >= 4 and parts[0] == 'vote':
                    pref = int(parts[-1])
                    val = item.value.strip()
                    if pref == 1:
                        choice_1 = val
                    elif pref == 2:
                        choice_2 = val
                    elif pref == 3:
                        choice_3 = val

        skey = _session_key(interaction.user.id, event_id)
        if skey not in _sessions:
            _sessions[skey] = {'event_id': event_id, 'team_id': team_id, 'votes': {}}
        _sessions[skey]['votes'][cat['id']] = {
            'choice_1': choice_1,
            'choice_2': choice_2,
            'choice_3': choice_3,
        }
        _sessions[skey]['current_index'] = current_index

        if is_last:
            await _finalize_votes(interaction, event_id, team_id, division_id,
                                  categories, _sessions[skey]['votes'])
            _sessions.pop(skey, None)
        else:
            next_modal = build_vote_modal(event_id, team_id, categories,
                                          current_index + 1, division_id,
                                          existing_data, nominees_by_cat)
            await interaction.response.send_modal(next_modal)

    modal.on_submit = on_submit
    return modal


async def handle_vote_button(interaction: discord.Interaction, event_id: int, team_id: int):
    """Handle the vote button click — start voting flow."""
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

    nom_cats = [c for c in categories if c['fill_type'] in ('nomination', 'autofill_player')]
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

    modal = build_vote_modal(event_id, team_id, categories, 0, division_id,
                             existing_data, nominees_by_cat)
    await interaction.response.send_modal(modal)


async def _finalize_votes(interaction: discord.Interaction, event_id: int,
                           team_id: int, division_id: int,
                           categories: list, vote_data: dict):
    """Save all votes to the database."""
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
                    'submitted_by': interaction.user.id,
                })
            else:
                _db.award_votes.insert({
                    'event_id': event_id,
                    'category_id': cat['id'],
                    'team_id': team_id,
                    'division_id': division_id,
                    'submitted_by': interaction.user.id,
                    'choice_1': choice_1,
                    'choice_2': vd.get('choice_2', ''),
                    'choice_3': vd.get('choice_3', ''),
                    'status': 'accepted',
                })
            saved += 1
        except Exception as e:
            logger.error(f'Failed to save vote: {e}')

    msg = f'✅ Votes submitted! ({saved}/{len(categories)} categories)'
    await interaction.response.send_message(msg, ephemeral=True)


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
