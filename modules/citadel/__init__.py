import requests

class Citadel:
    """
    An interface for the Citadel API.

    Requires a APIKey to be passed in the constructor

    Optional - Base URL for the API, defaults to 'https://ozfortress.com/api/v1/'

    Methods:

    getUser(id) - Get a user by their Citadel ID

    getUserBySteamID(steam_id) - Get a user by their Steam ID

    getTeam(id) - Get a team by their Citadel ID

    getLeague(id) - Get a league by their Citadel ID

    getRoster(id) - Get a roster by their Citadel ID

    getMatch(id) - Get a match by their Citadel ID
    """
    class User:
        """
        A class representing a user object from the Citadel API
        """
        def __init__(self, data):
            # Throw an error if the data doesnt have the required fields
            try:
                self.id = data['id'] # Integer
                self.name = data['name'] # String
                self.description = data['description'] # String
                self.created_at = data['created_at'] # DateTime(ISO 8601)
                self.profile_url = data['profile_url'] # String
                self.steam_32 = data['steam_32'] # String
                self.steam_64 = data['steam_64'] # Integer(64)
                self.setam_id3 = data['steam_id3'] # String
                self.teams = data['teams'] # [Team]
                self.rosters = data['rosters'] # [Roster]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')
    class Team:
        """
        A class representing a team object from the Citadel API
        """
        def __init__(self, data):
            # Throw an error if the data doesnt have the required fields
            try:
                self.id = data['id'] # Integer
                self.name = data['name'] # String
                self.description = data['description'] # String
                self.avatar_url = data['avatar_url'] # String
                self.avatar_thumb_url = data['avatar_thumb_url'] # String
                self.avatar_icon_url = data['avatar_icon_url'] # String
                self.players = data['players'] # [User]
                self.rosters = data['rosters'] # [Roster]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    class League:
        """
        A class representing a league object from the Citadel API
        """
        def __init__(self, data):
            # Throw an error if the data doesnt have the required fields
            try:
                self.id = data['id'] # Integer
                self.name = data['name'] # String
                self.description = data['description'] # String
                self.rosters = data['rosters'] # [Roster]
                self.matches = data['matches'] # [Match]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')
    class Roster:
        """
        A class representing a roster object from the Citadel API
        """
        def __init__(self, data):
            # Throw an error if the data doesnt have the required fields
            try:
                self.id = data['id'] # Integer
                self.name = data['name'] # String
                self.description = data['description'] # String
                self.division = data['division'] # String
                self.disbanded = data['disbanded'] # Boolean
                self.players = data['players'] # [User]
                self.matches = data['matches'] # [Match]
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    class Match:
        """
        A class representing a match object from the Citadel API
        """
        def __init__(self, data):
            # Throw an error if the data doesnt have the required fields
            try:
                self.id = data['id'] # Integer
                self.forfeit_by: data['forfeit_by'] # 'no_forfeit' | 'home_team_forfeit' | 'away_team_forfeit' | 'mutual_forfeit' | 'technical_forfeit'
                self.status = data['status'] # 'pending' | 'submitted_by_home_team' | 'submitted_by_away_team' | 'confirmed'
                self.round_name = data['round_name'] # String
                self.round_number = data['round_number'] # Integer
                self.notice = data['notice'] # String
                self.league = data['league'] # League
                self.home_team = data['home_team'] # Roster
                self.away_team = data['away_team'] # Roster
            except KeyError as e:
                raise ValueError(f'Missing required field: {e}')

    def __init__(self, apiKey, baseURL='https://ozfortress.com/api/v1/'):
        self.base_url = baseURL or 'https://ozfortress.com/api/v1/'
        if self.base_url[-1] != '/':
            self.base_url += '/' # Ensure the base URL ends with a slash
        self.api_key = apiKey

    def getUser(self, id):
        url = f'{self.base_url}users/{id}'
        headers = {'X-API-Key': self.api_key}
        response = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise ValueError(f'{response['status']} - {response['message']}')
        return self.User(response['user'])

    def getUserBySteamID(self, steam_id):
        # Steam ID must be 64 bit version, reject if not
        if len(steam_id) != 17: # dirty check
            return {'error': 'Invalid Steam ID'}
        url = f'{self.base_url}users/steam_id/{steam_id}'
        headers = {'X-API-Key': self.api_key}
        response = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise ValueError(f'{response['status']} - {response['message']}')
        return self.User(response['user'])

    def getTeam(self, id):
        url = f'{self.base_url}teams/{id}'
        headers = {'X-API-Key': self.api_key}
        response = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise ValueError(f'{response['status']} - {response['message']}')
        return self.Team(response['team'])

    def getLeague(self, id):
        url = f'{self.base_url}leagues/{id}'
        headers = {'X-API-Key': self.api_key}
        response = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise ValueError(f'{response['status']} - {response['message']}')
        return self.League(response['league'])

    def getRoster(self, id):
        url = f'{self.base_url}rosters/{id}'
        headers = {'X-API-Key': self.api_key}
        response = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise ValueError(f'{response['status']} - {response['message']}')
        return self.Roster(response['roster'])

    def getMatch(self, id):
        url = f'{self.base_url}matches/{id}'
        headers = {'X-API-Key': self.api_key}
        response = requests.get(url, headers=headers).json()
        if 'status' in response:
            raise ValueError(f'{response['status']} - {response['message']}')
        return self.Match(response['match'])

del requests
