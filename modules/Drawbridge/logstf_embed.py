import logging
import discord

from modules import citadel
from . import functions as Drawbridge
from . import citadel as Citadel
import modules.database as database
from modules.logging_config import get_logger
from discord.ext import commands as discord_commands
import os
import aiohttp
import datetime
import asyncio
from PIL import Image, ImageDraw, ImageFont
import io
from typing import Dict, List, Optional, Tuple

logger = get_logger('drawbridge.logstf_embed')

class LogsTFEmbed(discord_commands.Cog):
    def __init__ (self,client : discord_commands.Bot, db : database.Database, cit : Citadel.Citadel):
        self.db = db
        self.client = client
        self.cit = cit
        self.functions = Drawbridge.Functions(db, cit)
        self.antispam = {}

    @discord_commands.Cog.listener()
    async def on_message(self,message : discord.Message):
        # Ignore message if it doesnt contain a Logs.tf link
        if 'logs.tf/' not in message.content:
            return
        # reject other bots
        if message.author.bot:
            return

        # Anti-spam: Reject if user has posted a Logs.tf link in the last 30 seconds
        if message.author.id in self.antispam:
            if self.antispam[message.author.id] + 20 > message.created_at.timestamp():
                return

        valid = self.validateLogsTFURL(message)
        if valid :
            result = await self.generateEmbed(valid, include_scoreboard=True)  # Always include scoreboard
            if result:
                if isinstance(result, tuple):
                    # Result includes embed and file
                    embed, file, data = result
                    await message.channel.send(embed=embed, file=file)
                    # Try to determine metadata about these logs
                    
                    # is this a match channel?
                    match = self.db.matches.get_by_channel_id(message.channel.id)
                    if match:
                        team_home = self.cit.getTeam(match['team_home'])
                        team_away = self.cit.getTeam(match['team_away'])
                        
                        
                        if team_home and team_away:
                            # the logs has 12 players
                            async def announce_winner(home : citadel.Citadel.Team, away : citadel.Citadel.Team, map_name : str, home_score : int, away_score : int, log_id : int):
                                result_text = ""
                                if home_score > away_score:
                                    result_text = f"**{home['name']}** defeated **{away['name']}** on **{map_name}** ({home_score} - {away_score})"
                                elif away_score > home_score:
                                    result_text = f"**{away['name']}** defeated **{home['name']}** on **{map_name}** ({away_score} - {home_score})"
                                else:
                                    result_text = f"**{home['name']}** tied with **{away['name']}** on **{map_name}** ({home_score} - {away_score})"
                                if result_text:
                                    logger.info(f"Detected log result: {result_text} in logs.tf/{log_id}")
                                    await message.channel.send(result_text)
                                return
                                

                            if data and data['players'] and data['info'] and data['info']['map']:
                                red_players = [p for p in data['players'].keys() if data['players'][p]['team'] == 'Red']
                                blue_players = [p for p in data['players'].keys() if data['players'][p]['team'] == 'Blue']
                                for player in team_home['players']:
                                    if str(f'[{player['steam_id3']}]') in red_players:
                                        # home team is red
                                        await announce_winner(team_home, team_away, data['info']['map'], data['teams']['Red']['score'], data['teams']['Blue']['score'], valid)
                                        return
                                    elif str(f'[{player['steam_id3']}]') in blue_players:
                                        # home team is blue
                                        await announce_winner(team_home, team_away, data['info']['map'], data['teams']['Blue']['score'], data['teams']['Red']['score'], valid)
                                        return
                                for player in team_away['players']:
                                    if str(f'[{player['steam_id3']}]') in red_players:
                                        # away team is red
                                        await announce_winner(team_away, team_home, data['info']['map'], data['teams']['Red']['score'], data['teams']['Blue']['score'], valid)
                                        return
                                    elif str(f'[{player['steam_id3']}]') in blue_players:
                                        # away team is blue
                                        await announce_winner(team_away, team_home, data['info']['map'], data['teams']['Blue']['score'], data['teams']['Red']['score'], valid)
                                        return

                                else:
                                    logger.warning(f"Could not determine player teams for logs.tf/{valid}")
                            logger.warning(f"Could not determine match result for logs.tf/{valid}")
                        else:
                            logger.warning(f"Could not fetch team details for match {match['match_id']} when processing logs.tf/{valid}")
                    else:
                        return  # not a match channel, do nothing
                else:
                    # Result is just embed
                    await message.channel.send(embed=result)
            else:
                return
        else:
            return


        self.antispam[message.author.id] = message.created_at.timestamp()

    def validateLogsTFURL(self, message : discord.Message):
        # validate
        # we need the number after the first /, and before any #.
        parts = message.content.split('logs.tf/')
        if len(parts) < 2:
            return False
        # we need the number after the first /, and before any #. The # may not be present
        id = parts[1].split('/')[0]
        id = id.split('#')[0]
        if not id.isdigit():
            return False
        id = int(id)
        return id

    def convertSecondsIntoHumanReadable(self, seconds : int):
        minutes, sec = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        if hours > 0:
            return f"{hours}h {minutes}m {sec}s"
        elif minutes > 0:
            return f"{minutes}m {sec}s"
        else:
            return f"{sec}s"

    async def generateEmbed(self, id : int, include_scoreboard: bool = False):
        # fetch from logs.tf/api/v1/log/id

        url = f'https://logs.tf/api/v1/log/{id}'


        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    redscore = data['teams']['Red']['score']
                    bluescore = data['teams']['Blue']['score']
                    if not data['success']:
                        raise Exception(f"Logs.tf API request failed: {data.get('error', 'Unknown error (no success field)')}")
                    if not data['version'] == 3:
                        raise Exception(f"Unsupported Logs.tf API version (expected 3, got {data['version']})")
                    embed = discord.Embed(
                        title=f"{data['info']['title']}",
                        description=f"## [logs.tf/{id}](https://logs.tf/{id})\n\nMap: **{data['info']['map']}**\nDuration: **{self.convertSecondsIntoHumanReadable(data['length'])}**\nScore: **{bluescore} – {redscore}**",
                        timestamp=datetime.datetime.utcfromtimestamp(data['info']['date']),
                        color=(bluescore > redscore and discord.Color.from_str("0x3498db") or redscore > bluescore and discord.Color.from_str("0xe74c3c") or discord.Color.from_str("0x95a5a6")),
                        url=f"https://logs.tf/{id}"
                    )
                    embed.set_footer(text=f"Uploaded by {data['info']['uploader']['name']}")

                    # Add scoreboard image if requested
                    if include_scoreboard:
                        try:
                            scoreboard_data = await self.generate_scoreboard_image(data)

                            # Create Discord file from in-memory data (no saving to disk)
                            file = discord.File(
                                io.BytesIO(scoreboard_data),
                                filename=f"logstf_{id}_scoreboard.png"
                            )
                            embed.set_image(url=f"attachment://logstf_{id}_scoreboard.png")

                            return embed, file, data

                        except Exception as e:
                            print(f"Failed to generate scoreboard: {e}")
                            return embed, None, data

                    return embed
                else:
                    # Handle error response
                    return None

    def get_class_color(self, class_name: str) -> Tuple[int, int, int]:
        """Get TF2 class colors"""
        colors = {
            'scout': (164, 125, 101),
            'soldier': (178, 95, 95),
            'pyro': (175, 118, 95),
            'demoman': (95, 178, 95),
            'heavyweapons': (175, 125, 175),
            'engineer': (178, 163, 95),
            'medic': (178, 178, 95),
            'sniper': (124, 178, 157),
            'spy': (95, 118, 157),
        }
        return colors.get(class_name.lower(), (255, 255, 255))

    def get_team_color(self, team: str) -> Tuple[int, int, int]:
        """Get team colors"""
        colors = {
            'Red': (201, 79, 57),
            'Blue': (88, 133, 175),
        }
        return colors.get(team, (128, 128, 128))

    def get_class_sort_order(self, class_name: str) -> int:
        """Get class sort order (SCOUT, SOLDIER, PYRO, DEMO, HEAVY, ENGINEER, MEDIC, SNIPER, SPY)"""
        order = {
            'scout': 0,
            'soldier': 1,
            'pyro': 2,
            'demoman': 3,
            'heavyweapons': 4,
            'engineer': 5,
            'medic': 6,
            'sniper': 7,
            'spy': 8
        }
        return order.get(class_name.lower(), 99)

    def load_class_icon(self, class_name: str) -> Optional[Image.Image]:
        """Load class icon from embeds/icons directory"""
        try:
            # Map class names to icon filenames
            class_icon_map = {
                'scout': 'scout',
                'soldier': 'soldier',
                'pyro': 'pyro',
                'demoman': 'demoman',
                'heavyweapons': 'heavy',  # Important: heavyweapons -> heavy
                'engineer': 'engineer',
                'medic': 'medic',
                'sniper': 'sniper',
                'spy': 'spy'
            }

            icon_filename = class_icon_map.get(class_name.lower(), class_name.lower())

            # Try different path approaches
            icon_paths = [
                f"embeds/icons/Leaderboard_class_{icon_filename}.png",
                f"./embeds/icons/Leaderboard_class_{icon_filename}.png",
                os.path.join(os.getcwd(), "embeds", "icons", f"Leaderboard_class_{icon_filename}.png"),
                os.path.join(os.path.dirname(__file__), "..", "..", "embeds", "icons", f"Leaderboard_class_{icon_filename}.png")
            ]

            for icon_path in icon_paths:
                if os.path.exists(icon_path):
                    # print(f"Loading icon from: {icon_path}")  # Debug output
                    return Image.open(icon_path)

            print(f"No icon found for {class_name} (tried {len(icon_paths)} paths)")  # Debug output

        except Exception as e:
            print(f"Failed to load icon for {class_name}: {e}")
        return None

    async def generate_scoreboard_image(self, log_data: Dict) -> bytes:
        """Generate scoreboard image from logs.tf data"""

        # Image dimensions and styling
        player_row_height = 35
        team_header_height = 60  # Increased from 40
        column_header_height = 25

        # Get all players and combine teams
        all_players = []
        for steamid, player_data in log_data['players'].items():
            player_name = log_data['names'].get(steamid, 'Unknown')
            primary_class = max(player_data['class_stats'], key=lambda c: c['total_time'])['type']

            all_players.append({
                'steamid': steamid,
                'name': player_name,
                'data': player_data,
                'primary_class': primary_class,
                'team': player_data['team']
            })

        # Sort: Blue first, then Red, then by class order, then by kills
        def sort_key(player):
            team_priority = 0 if player['team'] == 'Blue' else 1
            class_order = self.get_class_sort_order(player['primary_class'])
            kills = player['data']['kills']
            return (team_priority, class_order, -kills)  # -kills for descending

        all_players.sort(key=sort_key)

        total_players = len(all_players)

        # Column headers with auto-sizing
        headers = ['Team', 'Class', 'Name', 'K', 'A', 'D', 'DMG', 'DPM', 'KA/D', 'K/D', 'DT', 'DT/M', 'HP', 'HS', 'AS', 'CAP']
        col_widths = [80, 100, 140, 35, 35, 35, 70, 50, 50, 45, 70, 50, 40, 35, 35, 40]  # Adjusted sizes

        # Calculate total width from content + padding
        padding = 10
        width = sum(col_widths) + (padding * 2)
        height = team_header_height + column_header_height + (total_players * player_row_height)

        col_positions = []
        x_pos = padding
        for width_val in col_widths:
            col_positions.append(x_pos)
            x_pos += width_val

        # Create image with auto-sized width
        background_color = 0x2d2d2d
        img = Image.new('RGB', (width, height), background_color)
        draw = ImageDraw.Draw(img)

        # Load Roboto fonts
        try:
            header_font_bold = ImageFont.truetype("embeds/fonts/Roboto-Bold.ttf", 36)
            player_font = ImageFont.truetype("embeds/fonts/Roboto-Bold.ttf", 14)
            small_font = ImageFont.truetype("embeds/fonts/Roboto-Bold.ttf", 12)
        except Exception as e:
            print(f"Failed to load Roboto fonts: {e}")
            header_font_bold = ImageFont.load_default()
            player_font = ImageFont.load_default()
            small_font = ImageFont.load_default()

        y_pos = 0

        # Team score header (blue left, red right, scores in center)
        blue_color = self.get_team_color('Blue')
        red_color = self.get_team_color('Red')

        # Draw team color backgrounds
        center_x = width // 2
        draw.rectangle([0, y_pos, center_x, y_pos + team_header_height], fill=blue_color)
        draw.rectangle([center_x, y_pos, width, y_pos + team_header_height], fill=red_color)

        # Team names at far ends with larger, bold text
        team_text_y = y_pos + (team_header_height - 36) // 2  # Center vertically for larger font
        draw.text((padding, team_text_y), "BLU", fill=(255, 255, 255), font=header_font_bold)

        red_text_bbox = draw.textbbox((0, 0), "RED", font=header_font_bold)
        red_text_width = red_text_bbox[2] - red_text_bbox[0]
        draw.text((width - red_text_width - padding, team_text_y), "RED", fill=(255, 255, 255), font=header_font_bold)

        # Scores in center with larger text
        blue_score = str(log_data['teams']['Blue']['score'])
        red_score = str(log_data['teams']['Red']['score'])

        # Blue score (right-aligned in blue section)
        blue_score_bbox = draw.textbbox((0, 0), blue_score, font=header_font_bold)
        blue_score_width = blue_score_bbox[2] - blue_score_bbox[0]
        draw.text((center_x - blue_score_width - 15, team_text_y), blue_score, fill=(255, 255, 255), font=header_font_bold)

        # Red score (left-aligned in red section)
        draw.text((center_x + 15, team_text_y), red_score, fill=(255, 255, 255), font=header_font_bold)

        y_pos += team_header_height

        # Draw column headers
        draw.rectangle([0, y_pos, width, y_pos + column_header_height], fill=(80, 80, 80))
        for header, col_x in zip(headers, col_positions):
            draw.text((col_x + 5, y_pos + 4), header, fill=(255, 255, 255), font=small_font)  # Adjusted y for larger font
        y_pos += column_header_height

        # Draw player rows
        for player in all_players:
            player_data = player['data']
            player_name = player['name']
            team = player['team']

            # Player background (alternating)
            bg_color = (50, 50, 50) if (y_pos // player_row_height) % 2 == 0 else (45, 45, 45)
            draw.rectangle([0, y_pos, width, y_pos + player_row_height], fill=bg_color)

            # Team column with team color and centered text
            team_color = self.get_team_color(team)
            draw.rectangle([col_positions[0], y_pos, col_positions[0] + col_widths[0], y_pos + player_row_height], fill=team_color)
            team_text = "BLU" if team == "Blue" else "RED"

            # Center the team text in the column
            team_text_bbox = draw.textbbox((0, 0), team_text, font=small_font)
            team_text_width = team_text_bbox[2] - team_text_bbox[0]
            team_text_x = col_positions[0] + (col_widths[0] - team_text_width) // 2
            draw.text((team_text_x, y_pos + 8), team_text, fill=(255, 255, 255), font=small_font)  # Adjusted y for larger font

            # Class icons column with padding
            class_x_offset = 5  # Start with some padding
            class_stats_by_time = sorted(player_data['class_stats'], key=lambda c: c['total_time'], reverse=True)

            for i, class_stat in enumerate(class_stats_by_time):
                class_name = class_stat['type']
                icon = self.load_class_icon(class_name)

                if icon:
                    # Resize icon to fit
                    icon_size = 20
                    icon = icon.resize((icon_size, icon_size), Image.Resampling.LANCZOS)

                    # Convert to RGBA if not already
                    if icon.mode != 'RGBA':
                        icon = icon.convert('RGBA')

                    # Apply opacity (100% for primary, 50% for others)
                    if i > 0:  # Not primary class
                        # Create a copy and modify the alpha channel
                        icon_array = list(icon.getdata()) # type: ignore
                        new_icon_data = []
                        for pixel in icon_array:
                            if len(pixel) == 4:  # RGBA
                                r, g, b, a = pixel
                                new_icon_data.append((r, g, b, int(a * 0.5)))  # 50% opacity
                            else:  # RGB
                                r, g, b = pixel
                                new_icon_data.append((r, g, b, 128))  # 50% opacity

                        icon.putdata(new_icon_data)

                    # Paste icon with padding
                    icon_x = col_positions[1] + class_x_offset
                    icon_y = y_pos + (player_row_height - icon_size) // 2

                    img.paste(icon, (icon_x, icon_y), icon)
                    class_x_offset += icon_size + 3  # 3px padding between icons
                else:
                    # Fallback: show class name if icon fails to load
                    class_text = class_name[:4].upper()
                    draw.text((col_positions[1] + class_x_offset, y_pos + 8),
                             class_text, fill=(255, 255, 255), font=small_font)  # Adjusted y for larger font
                    class_x_offset += 30

            # Calculate additional stats
            match_minutes = log_data['length'] / 60
            ka_deaths = (player_data['kills'] + player_data['assists']) / max(player_data['deaths'], 1)
            k_deaths = player_data['kills'] / max(player_data['deaths'], 1)
            dpm = round(player_data['dmg'] / match_minutes)  # Added DPM back
            dt_per_minute = round(player_data.get('dt', 0) / match_minutes)

            # Player data
            data = [
                "",  # Team column already drawn
                "",  # Class column already drawn
                player_name[:18],  # Slightly shorter to fit better
                str(player_data['kills']),
                str(player_data['assists']),
                str(player_data['deaths']),
                str(player_data['dmg']),
                str(dpm),  # DPM added back
                f"{ka_deaths:.1f}",
                f"{k_deaths:.1f}",
                str(player_data.get('dt', 0)),
                str(dt_per_minute),
                str(player_data.get('medkits', 0)),
                str(player_data.get('headshots', 0)),
                str(player_data.get('as', 0)),
                str(player_data.get('cpc', 0))
            ]

            # Draw text data (skip first two columns)
            for i, (text, col_x) in enumerate(zip(data[2:], col_positions[2:]), 2):
                text_color = (255, 255, 255) if i == 2 else (220, 220, 220)  # Name in white, others in light gray
                draw.text((col_x + 5, y_pos + 8), text, fill=text_color, font=player_font)  # Adjusted y for larger font

            y_pos += player_row_height

        # Convert to bytes
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        return buffer.getvalue()

