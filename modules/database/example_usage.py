#!/usr/bin/env python3
"""
Example usage of the refactored Drawbridge Database Module

This script demonstrates the key features and usage patterns
of the improved database module.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from modules.database import Database, DatabaseError


def main():
    """Main example function."""

    # Example connection parameters
    conn_params = {
        'host': 'localhost',
        'database': 'drawbridge',
        'user': 'your_username',
        'password': 'your_password',
        'pool_name': 'example_pool'
    }

    try:
        print("🔌 Connecting to database...")
        db = Database(conn_params)

        # Test health check
        if not db.health_check():
            print("❌ Database health check failed")
            return

        print("✅ Database connection healthy")

        # Get database statistics
        print("\n📊 Database Statistics:")
        stats = db.get_stats()
        for table, count in stats.items():
            print(f"  {table}: {count} records")

        # Example queries
        print("\n🔍 Example Queries:")

        # Get all leagues
        leagues = db.leagues.get_all()
        print(f"  Found {len(leagues)} leagues")

        if leagues:
            # Get teams for first league
            first_league = leagues[0]
            league_id = first_league['league_id']
            league_name = first_league['league_name']

            print(f"  Getting teams for league: {league_name}")
            teams = db.teams.get_by_league(league_id)
            print(f"    Found {len(teams)} teams")

            # Get divisions for league
            divisions = db.divisions.get_by_league(league_id)
            print(f"    Found {len(divisions)} divisions")

            # Get matches for league
            matches = db.matches.get_by_league(league_id)
            print(f"    Found {len(matches)} matches")

        # Example of the new get_match_details method
        print("\n🎮 Match Details Example:")
        all_matches = db.matches.get_all()
        if all_matches:
            match_id = all_matches[0]['match_id']
            match_details = db.get_match_details(match_id)

            if match_details:
                print(f"  Match ID: {match_details['match_id']}")
                print(f"  Division: {match_details['division']}")

                if match_details['home_team_details']:
                    print(f"  Home Team: {match_details['home_team_details']['team_name']}")

                if match_details['away_team_details']:
                    print(f"  Away Team: {match_details['away_team_details']['team_name']}")

        # Example repository operations
        print("\n⚙️  Repository Operations Example:")

        # Count operations
        total_teams = db.teams.count()
        print(f"  Total teams: {total_teams}")

        if leagues:
            league_teams = db.teams.count_by_league(leagues[0]['league_id'])
            print(f"  Teams in first league: {league_teams}")

        # Example error handling
        print("\n🛡️  Error Handling Example:")
        try:
            # This should raise an error for non-existent ID
            non_existent = db.teams.get_by_id(999999)
            print(f"  Non-existent team result: {non_existent}")
        except DatabaseError as e:
            print(f"  Caught database error: {e}")

        print("\n✅ All examples completed successfully!")

    except DatabaseError as e:
        print(f"❌ Database error: {e}")
    except KeyError as e:
        print(f"❌ Configuration error: {e}")
        print("   Make sure all required connection parameters are provided")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()


def example_insert_operations():
    """
    Example of insert operations (commented out to avoid modifying database).
    Uncomment and modify as needed for testing.
    """

    # conn_params = {...}
    # db = Database(conn_params)

    # Example league insert
    # new_league = {
    #     'league_id': 999,
    #     'league_name': 'Test League',
    #     'league_short': 'TEST',
    #     'league_description': 'A test league',
    #     'league_icon': 'test_icon.png'
    # }
    # league_id = db.leagues.insert(new_league)
    # print(f"Inserted league with ID: {league_id}")

    # Example team insert
    # new_team = {
    #     'roster_id': 9999,
    #     'team_id': 888,
    #     'league_id': 999,
    #     'role_id': 123456789,
    #     'team_channel': 987654321,
    #     'division': 1,
    #     'team_name': 'Test Team'
    # }
    # team_id = db.teams.insert(new_team)
    # print(f"Inserted team with ID: {team_id}")

    pass


if __name__ == "__main__":
    main()
