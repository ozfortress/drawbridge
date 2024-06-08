from ..checks import *
from ..functions import *

import discord
from discord.ext import commands
import os
import json
from modules import database
from modules import citadel

class GetTeams():
    def __init__(self, command_tree : discord.app_commands.CommandTree, db : database.Database, cit : citadel.Citadel):
        @Checks.heads_only()
        @command_tree.command(
            name='get-teams',
            guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        )
        async def get_teams(interaction : discord.Interaction, league_id : int, league_shortcode : str, is_hl : bool = False):
            """Generate team roles and channels for a given league

            Parameters
            -----------
            league_id: int
                The League ID to generate teams for
            league_shortcode: str
                The Shortcode for this league (eg: HL 27, 6s 30 ), this will be appended to role names.
            is_hl: bool
                Whether the league is Highlander or not. Default is False.
            """
            await interaction.response.send_message('Generating teams...', ephemeral=True)
            league = cit.getLeague(league_id)
            rosters = league.rosters
            divs = []
            file = open('embeds/teams.json', 'r')
            for roster in rosters:
                if roster['division'] not in divs:
                    divs.append(roster['division'])
                # trim team name to 20 char
                roster['role_name'] = f'{roster['name'][:20]} ({league_shortcode})'
                # role = await ctx.guild.create_role(name=role_name)
                # db.insert_team(roster)

            await interaction.response.edit_message(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league['name']}\nDivisions: {len(divs)}\nTeams: {len(rosters)}')
            r=0 #counters
            d=0 #counters
            for div in divs:
                d+=1
                catoverwrites = {
                    interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False),
                    # discord.Object(id=(is_hl == True ? roles['HL Admin'] : roles['6s Admin'])) : discord.PermissionOverwrite(read_messages=True),
                    discord.Object(id=Checks.roles['6s Head']) : discord.PermissionOverwrite(read_messages=True),
                    discord.Object(id=Checks.roles['HL Head']) : discord.PermissionOverwrite(read_messages=True),
                    discord.Object(id=Checks.roles['Trial Admin']) : discord.PermissionOverwrite(read_messages=True), # Or false? dunno hey.
                    discord.Object(id=Checks.roles['Developers']) : discord.PermissionOverwrite(read_messages=True),
                    discord.Object(id=Checks.roles['Approved Casters']) : discord.PermissionOverwrite(read_messages=False),
                    discord.Object(id=Checks.roles['Unapproved Casters']) : discord.PermissionOverwrite(read_messages=False),
                    discord.Object(id=Checks.roles['Captains Bot']) : discord.PermissionOverwrite(read_messages=True)
                }
                if is_hl:
                    catoverwrites[discord.Object(id=Checks.roles['HL Admin'])] = discord.PermissionOverwrite(read_messages=True)
                else:
                    catoverwrites[discord.Object(id=Checks.roles['6s Admin'])] = discord.PermissionOverwrite(read_messages=True)

                channelcategory = await interaction.guild.create_category(f'{div} - {league_shortcode}')
                role = await interaction.guild.create_role(name=f'{div} - {league_shortcode}')
                dbdiv = {
                    'division': div,
                    'role_id': role.id,
                    'category_id': channelcategory.id
                }
                divid = db.insert_div(dbdiv)
                for roster in rosters:
                    if roster['division'] == div:
                        r+=1
                        role = await interaction.guild.create_role(name=f'{roster['name']} ({league_shortcode})', mentionable=True)
                        overwrites = {
                            role: discord.PermissionOverwrite(read_messages=True),
                        }
                        teamchannel = await interaction.guild.create_text_channel(f'{roster['name']} ({league_shortcode})', category=channelcategory, overwrites=overwrites)

                        # Load the chat message from embeds/teams.json

                        teammessage = json.load(file)
                        teammessage = Functions.substitute_strings_in_embed(teammessage, {
                            '{TEAM_MENTION}': f'<@&{role.id}>',
                            '{TEAM_NAME}': roster['name'],
                            '{TEAM_ID}': roster['id'],
                            '{DIVISION}': div,
                            '{LEAGUE_NAME}': league['name'],
                            '{LEAGUE_SHORTCODE}': league_shortcode,
                            '{CHANNEL_ID}': str(teamchannel.id),
                            '{CHANNEL_LINK}': f'<#{teamchannel.id}>',
                        })
                        teammessage['embed'] = teammessage['embeds'][0]
                        del teammessage['embeds']
                        await teamchannel.send(**teammessage)
                        await interaction.response.edit_message(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league['name']}\nDivisions: {d}/{len(divs)}\nTeams: {r}/{len(rosters)}')
                        dbteam = {
                            'team_id': roster['id'],
                            'role_id': role.id,
                            'team_channel': teamchannel.id,
                            'division': divid,
                            'team_name': roster['name']
                        }
                        db.insert_team(dbteam)
            await interaction.response.edit_message(content=f'Generated.\nLeague: {league['name']}\nDivisions: {d}/{len(divs)}\nTeams: {r}/{len(rosters)}')

        @get_teams.error
        async def get_teams_error(ctx : discord.Interaction, error):
            if isinstance(error, commands.errors.MissingPermissions):
                await ctx.response.send_message(content='You do not have permission to run this command.', ephermeral=True)
            else:
                await ctx.response.send_message(content='An error occurred while running this command.', ephermeral=True)
