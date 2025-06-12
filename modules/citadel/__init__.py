"""
CItadel API Wrapper for ozfortress.com
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

:copyright: (c) 2024-present ozfortress"""

__title__ = 'citadel'
__author__ = 'ozfortress'
__license__ = 'None'
__version__ = '0.0.1'
__copyright__ = 'Copyright 2024-present ozfortress'

__path__ = __import__('pkgutil').extend_path(__path__, __name__)

from typing import Optional
import requests
import json

class Citadel:
    """
    A class representing the Citadel API.

    This class provides methods to interact with the Citadel API, allowing you to retrieve information about users, teams, leagues, rosters, and matches.

    Args:
        apiKey (str): The API key required to access the Citadel API.
        baseURL (str, optional): The base URL of the Citadel API. Defaults to 'https://ozfortress.com/api/v1/'.

    Raises:
        ValueError: If the API key is not provided when initializing the Citadel API.
    """
    class APIException(Exception):
        """
        An exception raised when an error occurs while interacting with the Citadel API.

        Attributes:
            status (int): The status code of the error response.
            message (str): The error message returned by the API.
        """
        def __init__(self, status: int, message: str) -> None:
            self.status = status
            self.message = message


    class _BaseCitadelObject:
        def __getitem__(self, key):
            return self.__dict__[key]
        def __init__(self, data: dict) -> None:
            pass
        def __str__(self) -> str:
            return json.dumps(self.__dict__)
        def __repr__(self) -> str:
            return json.dumps(self.__dict__)

    class PartialUser(_BaseCitadelObject):
        """
        Represents a user in the Citadel module. This is a partial user.

        Attributes
        ----------
        id: int
            The user's ID.
        name: str
            The user's name.
        description: str
            The user's description.
        created_at: str
            The user's creation date and time (in ISO 8601 format).
        profile_url: str
            The user's profile URL.
        steam_32: str
            The user's Steam 32-bit ID.
        steam_64: int
            The user's Steam 64-bit ID.
        steam_id3: str
            The user's Steam ID3.
        discord_id: Optional[int]
            The user’s linked Discord ID (if linked)
        """
        def __init__(self, data : dict) -> None:
            # Throw an error if the data doesnt have the required fields
            try:
                self.id: int = data['id'] # Integer
                self.is_captain = data.get('is_captain', False) # Boolean
                self.name: str = data['name'] # String
                self.description: str = data['description'] # String
                self.created_at: str = data['created_at'] # DateTime(ISO 8601)
                self.profile_url: str = data['profile_url'] # String
                self.steam_32: str = data['steam_32'] # String
                self.steam_64: int = data['steam_64'] # Integer(64)
                self.steam_id3: str = data['steam_id3'] # String
                self.discord_id: Option[int] = data['discord_id']
                # self.teams: list[Citadel.Team] | None = data['teams'] # [Team]
                # self.rosters: list[Citadel.Roster] | None = data['rosters'] # [Roster]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')
    class User(PartialUser):
        """
        Represents a user in the Citadel module.

        Attributes
        ----------
        id: int
            The user's ID.
        name: str
            The user's name.
        description: str
            The user's description.
        created_at: str
            The user's creation date and time (in ISO 8601 format).
        profile_url: str
            The user's profile URL.
        steam_32: str
            The user's Steam 32-bit ID.
        steam_64: int
            The user's Steam 64-bit ID.
        steam_id3: str
            The user's Steam ID3.
        discord_id: Optional[int]
            The user’s linked Discord ID (if linked)
        teams: list[Citadel.Team]
            The teams the user belongs to.
        rosters: list[Citadel.Roster]
            The rosters the user is part of.
        """
        def __init__(self, data: dict) -> None:
            super().__init__(data)
            try:
                self.teams: list[Citadel.PartialTeam] = data['teams'] # [Team]
                self.rosters: list[Citadel.PartialRoster] = data['rosters'] # [Roster]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    class PartialTeam(_BaseCitadelObject):
        """
        Represents a partial team in the Citadel module.

        Attributes
        ----------
        id: int
            The team's ID.
        name: str
            The team's name.
        description: str
            The team's description.
        avatar_url: str
            The team's avatar URL.
        avatar_thumb_url: str
            The team's avatar thumbnail URL.
        avatar_icon_url: str
            The team's avatar icon URL.
        players: list[Citadel.User] | None
            The players in the team (optional).
        rosters: list[Citadel.Roster] | None
            The rosters in the team (optional).
        """

        def __init__(self, data: dict) -> None:
            # Throw an error if the data doesnt have the required fields
            try:
                self.id: int = data['id'] # Integer
                self.name: str = data['name'] # String
                self.description: str = data['description'] # String
                self.avatar_url: str = data['avatar_url'] # String
                self.avatar_thumb_url: str = data['avatar_thumb_url'] # String
                self.avatar_icon_url: str = data['avatar_icon_url'] # String
                # self.players: list[Citadel.PartialUser] | None = data['players'] # [User]
                # self.rosters: list[Citadel.PartialRoster] | None = data['rosters'] # [Roster]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    class Team(PartialTeam):
        """
        Represents a team in the Citadel module.

        Attributes
        ----------
        id: int
            The team's ID.
        name: str
            The team's name.
        description: str
            The team's description.
        avatar_url: str
            The team's avatar URL.
        avatar_thumb_url: str
            The team's avatar thumbnail URL.
        avatar_icon_url: str
            The team's avatar icon URL.
        players: list[Citadel.User]
            The players in the team.
        rosters: list[Citadel.Roster]
            The rosters in the team.
        """
        def __init__(self, data: dict) -> None:
            super().__init__(data)
            try:
                self.players: list[Citadel.PartialUser] = data['players'] # [User]
                self.rosters: list[Citadel.PartialRoster] = data['rosters'] # [Roster]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    class PartialLeague(_BaseCitadelObject):
        """
        Represents a league in the Citadel module.

        Attributes
        ----------
        id: int
            The league's ID.
        name: str
            The league's name.
        description: str
            The league's description.
        """
        def __init__(self, data: dict) -> None:
            # Throw an error if the data doesnt have the required fields
            try:
                self.id: int = data['id'] # Integer
                self.name: str = data['name'] # String
                self.description: str = data['description'] # String
                # self.rosters: list[Citadel.PartialRoster] | None = data['rosters'] # [Roster]
                # self.matches: list[Citadel.PartialMatch] | None = data['matches'] # [Match]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')
            
    class League(PartialLeague):
        """
        Represents a league in the Citadel module.
        
        Attributes
        ----------
        id: int
            The league's ID.
        name: str
            The league's name.
        description: str
            The league's description.
        rosters: list[Citadel.Roster] | None
            The rosters in the league (optional).
        matches: list[Citadel.Match] | None
            The matches in the league (optional).
        """
        def __init__(self, data: dict) -> None:
            super().__init__(data)
            try:
                self.rosters: list[Citadel.PartialRoster] = data['rosters'] # [Roster]
                self.matches: list[Citadel.PartialMatch] = data['matches'] # [Match]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')


    class PartialRoster(_BaseCitadelObject):
        """
        Represents a roster in the Citadel module. This is only a partial roster, missing some fields as a consequence of being requested as a child of a league

        Attributes
        ----------
        id: int
            The roster's ID.
        team_id: int
            The team's ID.
        name: str
            The roster's name.
        description: str
            The roster's description.
        division: str
            The roster's division.
        disbanded: bool
            Whether the roster has been disbanded.
        """
        def __init__(self, data: dict) -> None:
            # Throw an error if the data doesnt have the required fields
            try:
                self.id: int = data['id'] # Integer
                self.team_id: int = data['team_id'] # Integer
                self.name: str = data['name'] # String
                self.description: str = data['description'] # String
                self.division: str = data['division'] # String
                self.disbanded: bool = data['disbanded'] # Boolean
                #self.players: list[Citadel.User] | None = data['players'] # [User]
                #self.matches: list[Citadel.PartialMatch] | None = data['matches'] # [Match]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')
    class Roster(PartialRoster):
        """
        Represents a roster in the Citadel module.

        Attributes
        ----------
        id: int
            The roster's ID.
        team_id: int
            The team's ID.
        name: str
            The roster's name.
        description: str
            The roster's description.
        division: str
            The roster's division.
        disbanded: bool
            Whether the roster has been disbanded.
        players: list[Citadel.User]
            The players in the roster.
        matches: list[Citadel.Match]
            The matches the roster is part of.
        """
        def __init__(self, data: dict) -> None:
            super().__init__(data)
            try:
                self.players: list[Citadel.PartialUser] = data['players'] # [User]
                self.matches: list[Citadel.PartialMatch] = data['matches'] # [Match]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    class PartialMatch(_BaseCitadelObject):
        """
        Represents a partial match in the Citadel module. This minified version of the Match object is used as a child of Rosters and Leagues, and misses some fields.

        Attributes
        ----------
        id: int
            The match's ID.
        forfeit_by: str
            The match's forfeit status.
        status: str
            The match's status.
        round_name: str
            The match's round name.
        round_number: int
            The match's round number.
        notice: str
            The match's notice.
        league: Citadel.League
            The league the match is part of.
        home_team: Citadel.Roster
            The home team in the match.
        away_team: Citadel.Roster
            The away team in the match.
        """
        def __init__(self, data: dict) -> None:
            # Throw an error if the data doesnt have the required fields
            if data['forfeit_by'] not in ['no_forfeit', 'home_team_forfeit', 'away_team_forfeit', 'mutual_forfeit', 'technical_forfeit']:
                raise ValueError(f'Invalid value for forfeit_by, got {data['forfeit_by']}, expected one of: no_forfeit, home_team_forfeit, away_team_forfeit, mutual_forfeit, technical_forfeit')
            if data['status'] not in ['pending', 'submitted_by_home_team', 'submitted_by_away_team', 'confirmed']:
                raise ValueError(f'Invalid value for status, got {data['status']}, expected one of: pending, submitted_by_home_team, submitted_by_away_team, confirmed')
            try:
                self.id: int = data['id'] # Integer
                self.forfeit_by: str['no_forfeit'] | str['home_team_forfeit'] | str['away_team_forfeit'] | str['mutual_forfeit'] | str['technical_forfeit'] = data['forfeit_by'] # 'no_forfeit' | 'home_team_forfeit' | 'away_team_forfeit' | 'mutual_forfeit' | 'technical_forfeit'
                self.status: str['pending'] | str['submitted_by_home_team'] | str['submitted_by_away_team'] | str['confirmed'] = data['status'] # 'pending' | 'submitted_by_home_team' | 'submitted_by_away_team' | 'confirmed'
                self.round_name: str = data['round_name'] # String
                self.round_number: int = data['round_number'] # Integer
                self.notice: str = data['notice'] # String
                #self.league: Citadel.League = data['league'] # League
                #self.home_team: Citadel.Roster = data['home_team'] # Roster
                #self.away_team: Citadel.Roster = data['away_team'] # Roster
                #self.league_id = data['league']['id']
                self.created_at: str = data['created_at']
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    class Match(PartialMatch):
        """
        A class to represent a Match.

        Attributes:
        -----------
        league : Citadel.League
            The league to which the match belongs.
        home_team : Citadel.Roster
            The home team participating in the match.
        away_team : Citadel.Roster
            The away team participating in the match.
        league_id : int
            The ID of the league.

        Methods:
        --------
        __init__(data: dict) -> None
            Initializes the Match object with data from a dictionary.
        """
        def __init__(self, data:dict) -> None:
            super().__init__(data)
            try:
                self.league: Citadel.PartialLeague = data['league'] # League
                self.home_team: Citadel.PartialRoster = data['home_team'] # Roster
                self.away_team: Citadel.PartialRoster | None = data.get('away_team') # Roster
                self.league_id = data['league']['id']
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    def __init__(self, apiKey: str, baseURL='https://ozfortress.com/api/v1/'):
        if not apiKey:
            raise ValueError('API Key is required when initializing Citadel API')
        self._base_url: str = baseURL or 'https://ozfortress.com/api/v1/'
        if self._base_url[-1] != '/':
            self._base_url += '/' # Ensure the base URL ends with a slash
        self._api_key: str = apiKey

    def getUser(self, id: int) -> User:
        """
        Retrieves a user from the API based on the provided ID.

        Args:
            id (int): The ID of the user to retrieve.

        Returns:
            User: An instance of the User class representing the retrieved user.

        Raises:
            Citadel.APIException: If the API response contains a status and message indicating an error.
        """
        url = f'{self._base_url}users/{id}'
        headers = {'X-API-Key': self._api_key}
        response: dict = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise Citadel.APIException(response['status'], response['message'])
        return self.User(response['user'])

    def getUserBySteamID(self, steam_id: str|int) -> User:
        """
        Retrieves a user by their Steam ID.

        Args:
            steam_id (str|int): The Steam ID of the user. Must be a 64-bit version.

        Returns:
            User: The user object corresponding to the given Steam ID.

        Raises:
            ValueError: If the Steam ID is invalid or not a 64-bit version.
            Citadel.APIException: If the API response contains an error status.
        """
        # Steam ID must be 64 bit version, reject if not
        if len(steam_id) != 17 | steam_id.isdigit() == False: # dirty check
            raise ValueError('Invalid Steam ID, must be 64 bit version')
        url = f'{self._base_url}users/steam_id/{steam_id}'
        headers = {'X-API-Key': self._api_key}
        response: dict = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise Citadel.APIException(response['status'], response['message'])
        return self.User(response['user'])

    def getUserByDiscordID(self, discord_id: str | int) -> Optional[User]:
        """
        Retrieves a user by their Discord ID.

        Args:
            discord_id (str|int): The Discord ID of the user.

        Returns:
            Optional[User]: The user object corresponding to the given Discord
            ID, if it exists. Otherwise, will return None.

        Raises:
            Citadel.APIException: If the API response contains an error status.
        """
        url = f'{self._base_url}users/discord_id/{discord_id}'
        headers = {'X-API-Key': self._api_key}
        response: dict = requests.get(url, headers=headers).json()
        if 'status' in response:
            if response['status'] == 404:
                return None
            else:
                raise Citadel.APIException(
                    response['status'], response['message'])
        return self.User(response['user'])

    def getTeam(self, id: int) -> Team:
        """
        Retrieves a team from the API based on the provided ID.

        Args:
            id (int): The ID of the team to retrieve.

        Returns:
            Team: An instance of the Team class representing the retrieved team.

        Raises:
            Citadel.APIException: If the API response contains a status and message indicating an error.
        """
        url = f'{self._base_url}teams/{id}'
        headers = {'X-API-Key': self._api_key}
        response: dict = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise Citadel.APIException(response['status'], response['message'])
        return self.Team(response['team'])

    def getLeague(self, id: int) -> League:
        """
        Retrieves information about a specific league.

        Args:
            id (int): The ID of the league to retrieve.

        Returns:
            League: An instance of the League class representing the retrieved league.

        Raises:
            Citadel.APIException: If the API response contains an error status.

        """
        url = f'{self._base_url}leagues/{id}'
        headers = {'X-API-Key': self._api_key}
        response: dict = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise Citadel.APIException(response['status'], response['message'])
        return self.League(response['league'])

    def getRoster(self, id: int) -> Roster:
        """
        Retrieves a roster based on the given ID.

        Args:
            id (int): The ID of the roster to retrieve.

        Returns:
            Roster: The retrieved roster object.

        Raises:
            Citadel.APIException: If the response contains a status and message.

        """
        url = f'{self._base_url}rosters/{id}'
        headers = {'X-API-Key': self._api_key}
        response: dict = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise Citadel.APIException(response['status'], response['message'])
        return self.Roster(response['roster'])

    def getMatch(self, id: int) -> Match:
        """
        Retrieves a match with the given ID from the API.

        Args:
            id (int): The ID of the match to retrieve.

        Returns:
            Match: The retrieved match object.

        Raises:
            Citadel.APIException: If the API response contains an error status.
        """
        url = f'{self._base_url}matches/{id}'
        headers = {'X-API-Key': self._api_key}
        response: dict = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise Citadel.APIException(response['status'], response['message'])
        return self.Match(response['match'])

__all__ = ['Citadel']
