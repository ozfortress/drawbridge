if __name__ != '__main__':
    raise ImportError('This is not a module. Please run app.py instead.')

import logging
import os
from dotenv import load_dotenv
import subprocess
import time
import discord
from discord.ext import commands
from discord import app_commands
import modules.citadel as citadel
import modules.database as database


load_dotenv()

if not os.path.exists('logs'):
    os.makedirs('logs')
logger = logging.getLogger(__name__)
VERSION = '0.0.1'

intents = discord.Intents.all() # TODO: Change this to only the intents we need

client = discord.Client(intents=intents)
cmds = app_commands.CommandTree(client)

roles={
    'Director' : '1243181553522053191', # League Director
    '6s Head' : '1243184095878709249', # 6s Head Admin
    'HL Head' : '1243184165072011368', # HL Head Admin
    '6s Admin' : '1243183240471253134', # 6s Admin
    'HL Admin' : '1243183285824126976', # HL Admin
    'Trial Admin' : '1243197012443267113', # Trial Admin
    'Developers' : '1243183754625814599', # Developers
    'Approved Casters' : '1243192943548829726', # Approved Casting
    'Unapproved Casters' : '1243193009768497334', # Unapproved Casting
    'Captains Bot': '1248508402275975169'
}

db = database.Database( conn_params={
    "database": os.getenv('DB_DATABASE'),
    "user": os.getenv('DB_USER'),
    "password": os.getenv('DB_PASS'),
    "host": os.getenv('DB_HOST'),
    "port": int(os.getenv('DB_PORT'))
})
cit = citadel.Citadel(os.getenv('CITADEL_API_KEY'))
teamchannel_cache={
    'channels' : {
    },
    'refreshAfter': 0 # timestamp representing the next time the cache should be refreshed
}
class Drawbridge: pass

def main():
    logging.basicConfig(filename='logs/drawbridge.log', level='DEBUG', format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging._nameToLevel[os.getenv('LOG_LEVEL', 'INFO')])
    console_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(console_handler)
    logger.info(f'Starting OZF Drawbridge v{VERSION}...')
    # checkPackages()
    logger.info('OZF Drawbridge has started.')
    client.run(os.getenv('DISCORD_TOKEN'))

@client.event
async def on_ready():
    logger.info(f'Logged in as {client.user.name}#{client.user.discriminator} ({client.user.id})')
    logger.info(f'Cmds: {cmds.get_commands()}')
    synced_commands = await cmds.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))
    logger.info(f'Synced {len(synced_commands)} commands.')
    for synced_command in synced_commands:
        logger.debug(f'Synced command: {synced_command.name}')


def generate_log(message : discord.Message, is_team : bool, match_id=0, log_type="CREATE", after : discord.Message=None):
    log = {}
    if is_team:
        team = database.get_team_by_channel_id(message.channel.id)
        if not team:
            return None
        log['match_id'] = 0
        log['team'] = team['team_id']
    else:
        if not match_id:
            return None
        match = db.get_match_details(match_id)
        teamsRoles = []
        teamsRoles.append(match['team_home'].role_id)
        teamsRoles.append(match['team_away'].role_id)
        log['match_id'] = match_id

        for teamRole in teamsRoles:
            if teamRole in message.author.roles:
                log['team'] = database.get_team_id_of_role(teamRole)
                break
        if 'team' not in log:
            log['team'] = None # Admin or Caster?
            #TODO: Handle Admins and Casters
    log['user_id'] = message.author.id
    log['user_name'] = message.author.name
    log['user_nick'] = message.author.nick
    log['user_avatar'] = message.author.display_avatar.url
    log['message_id'] = message.id
    log['message_content'] = message.content

    if message.attachments:
        log['message_additionals'] = ' '.join([attachment.url for attachment in message.attachments])
    else:
        log['message_additionals'] = ''
    log['log_type'] = log_type # CREATE / DELETE / EDIT
    log['log_timestamp'] = message.created_at
    if log_type == "EDIT":
        log['message_content'] = after.content
        log['log_timestamp'] = after.edited_at
    if log_type == "DELETE":
        log['log_timestamp'] = int(time.time())
    db.insert_log(log)
    logger.debug(f'new log {message.author.name}#{message.author.discriminator} ({message.author.id}) - {log_type}')

@client.event
async def on_message(message : discord.Message):
    match_id = db.get_match_id_of_channel(message.channel.id)
    if match_id:
        generate_log(message, False, match_id, "CREATE")
    else:
        # Verify cache is up to date
        if teamchannel_cache['refreshAfter'] < time.time():
            channels = db.get_team_channels()
            for channel in channels:
                teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            teamchannel_cache['refreshAfter'] = time.time() + 3600*24
        if message.channel.id in teamchannel_cache['channels']:
            generate_log(message, True, 0, "CREATE")

@client.event
async def on_message_edit(before : discord.Message, after : discord.Message):
    match_id = db.get_match_id_of_channel(after.channel.id)
    if match_id:
        generate_log(before, False, match_id, "EDIT", after)
    else:
        # Verify cache is up to date
        if teamchannel_cache['refreshAfter'] < time.time():
            channels = db.get_team_channels()
            for channel in channels:
                teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            teamchannel_cache['refreshAfter'] = time.time() + 3600*24
        if after.channel.id in teamchannel_cache['channels']:
            generate_log(before, True, 0, "EDIT", after)

@client.event
async def on_message_delete(message : discord.Message):
    # WARNING - UNRELIABLE - MIGHT MISS OLD MSGS if they arent in cache.
    match_id = db.get_match_id_of_channel(message.channel.id)
    if match_id:
        generate_log(message, False, match_id, "DELETE")
    else:
        # Verify cache is up to date
        if teamchannel_cache['refreshAfter'] < time.time():
            channels = db.get_team_channels()
            for channel in channels:
                teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            teamchannel_cache['refreshAfter'] = time.time() + 3600*24
        if message.channel.id in teamchannel_cache['channels']:
            generate_log(message, True, 0, "DELETE")

# @client.check
# async def globally_block_dms(ctx):
#     return ctx.guild is not None # Only allow commands to be run in a guild

@cmds.command(
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
            discord.Object(id=roles['6s Head']) : discord.PermissionOverwrite(read_messages=True),
            discord.Object(id=roles['HL Head']) : discord.PermissionOverwrite(read_messages=True),
            discord.Object(id=roles['Trial Admin']) : discord.PermissionOverwrite(read_messages=True), # Or false? dunno hey.
            discord.Object(id=roles['Developers']) : discord.PermissionOverwrite(read_messages=True),
            discord.Object(id=roles['Approved Casters']) : discord.PermissionOverwrite(read_messages=False),
            discord.Object(id=roles['Unapproved Casters']) : discord.PermissionOverwrite(read_messages=False),
            discord.Object(id=roles['Captains Bot']) : discord.PermissionOverwrite(read_messages=True)
        }
        if is_hl:
            catoverwrites[discord.Object(id=roles['HL Admin'])] = discord.PermissionOverwrite(read_messages=True)
        else:
            catoverwrites[discord.Object(id=roles['6s Admin'])] = discord.PermissionOverwrite(read_messages=True)

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
                role = await interaction.guild.create_role(name=f'{roster['name']} ({league_shortcode})')
                overwrites = {
                    role: discord.PermissionOverwrite(read_messages=True),
                }
                teamchannel = await interaction.guild.create_text_channel(f'{roster['name']} ({league_shortcode})', category=channelcategory, overwrites=overwrites)

                await teamchannel.send(f'Welcome to the {roster['name']} team channel! This is placeholder text.')
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



# def checkPackages():
#     with open('requirements.txt', 'r') as file:
#         requiredPackages = file.read().splitlines()
#     installedPackages = subprocess.check_output(['pip', 'freeze']).decode('utf-8').splitlines()
#     missingPackages = [package for package in requiredPackages if package not in installedPackages]
#     if missingPackages:
#         logger.warning(f'The following packages are missing: {missingPackages}')
#         logger.warning('Installing missing packages...')
#         subprocess.check_call(['pip', 'install', *missingPackages])
#         logger.info('All missing packages have been installed.')
#     else:
#         logger.info('All packages are already installed.')

if __name__ == '__main__':
    main()

# Path: app.py
