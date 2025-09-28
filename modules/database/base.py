"""
Database Module for Drawbridge - Base Components
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Core database components and base classes.

:copyright: (c) 2024-present ozfortress
"""

import mariadb
import os
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Union, Tuple
from contextlib import contextmanager
from modules.logging_config import DatabaseLogger


class DatabaseError(Exception):
    """Custom exception for database operations."""
    pass


class DatabaseConnection:
    """Manages database connection pool and provides connection context."""

    def __init__(self, conn_params: Dict[str, Any]):
        self._validate_config(conn_params)
        self.db_logger = DatabaseLogger()

        if not conn_params.get('pool_name'):
            conn_params['pool_name'] = 'drawbridge'

        self.pool = mariadb.ConnectionPool(**conn_params)
        # Use the database logger from logging_config
        self.logger = self.db_logger.logger

    def _validate_config(self, conn_params: Dict[str, Any]) -> None:
        """Validate database connection parameters."""
        required_keys = ['host', 'database', 'user', 'password']
        for key in required_keys:
            if key not in conn_params:
                raise KeyError(f'No {key.title()} provided for DB connection')

    @contextmanager
    def get_connection(self):
        """Context manager for database connections."""
        conn = None
        try:
            conn = self.pool.get_connection()
            yield conn
        except mariadb.Error as e:
            if conn:
                conn.rollback()
            self.logger.error(f"Database error: {e}", exc_info=True)
            raise DatabaseError(f"Database operation failed: {e}")
        finally:
            if conn:
                conn.close()

    def health_check(self) -> bool:
        """Check database connection health."""
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT 1")
                return True
        except DatabaseError:
            return False


class BaseRepository(ABC):
    """Base class for all database repositories."""

    def __init__(self, db_connection: DatabaseConnection, table_name: str):
        self.db = db_connection
        self.table = table_name
        self.logger = db_connection.logger

    def _execute_query(self, query: str, params: Tuple = ()) -> int:
        """Execute a query that modifies data (INSERT, UPDATE, DELETE)."""
        self.db.db_logger.log_query(query, params)
        try:
            with self.db.get_connection() as conn:
                cursor = conn.cursor(dictionary=True)
                cursor.execute(query, params)
                conn.commit()
                result = cursor.lastrowid or cursor.rowcount or 0
                self.logger.debug(f"Query executed successfully, affected rows/ID: {result}")
                return result
        except Exception as e:
            self.db.db_logger.log_error("_execute_query", e)
            raise DatabaseError(f"Query execution failed: {e}") from e

    def _fetch_one(self, query: str, params: Tuple = ()) -> Optional[Dict[str, Any]]:
        """Execute a query that returns a single result."""
        self.db.db_logger.log_query(query, params)
        try:
            with self.db.get_connection() as conn:
                cursor = conn.cursor(dictionary=True)
                cursor.execute(query, params)
                result = cursor.fetchone()
                self.logger.debug(f"Fetch one query executed, result: {'found' if result else 'not found'}")
                return result
        except Exception as e:
            self.db.db_logger.log_error("_fetch_one", e)
            raise DatabaseError(f"Query execution failed: {e}") from e

    def _fetch_all(self, query: str, params: Tuple = ()) -> List[Dict[str, Any]]:
        """Execute a query that returns multiple results."""
        self.db.db_logger.log_query(query, params)
        try:
            with self.db.get_connection() as conn:
                cursor = conn.cursor(dictionary=True)
                cursor.execute(query, params)
                results = cursor.fetchall()
                self.logger.debug(f"Fetch all query executed, returned {len(results)} rows")
                return results
        except Exception as e:
            self.db.db_logger.log_error("_fetch_all", e)
            raise DatabaseError(f"Query execution failed: {e}") from e

    def _fetch_scalar(self, query: str, params: Tuple = ()) -> Any:
        """Execute a query that returns a single value."""
        result = self._fetch_one(query, params)
        if result:
            return next(iter(result.values()))
        return None

    @abstractmethod
    def get_by_id(self, id: Any) -> Optional[Dict[str, Any]]:
        """Get a record by its primary key."""
        pass

    @abstractmethod
    def get_all(self) -> List[Dict[str, Any]]:
        """Get all records."""
        pass

    @abstractmethod
    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        """Insert a new record."""
        pass

    @abstractmethod
    def update(self, id: Any, data: Dict[str, Any]) -> bool:
        """Update an existing record."""
        pass

    @abstractmethod
    def delete(self, id: Any) -> bool:
        """Delete a record by its primary key."""
        pass

    def count(self) -> int:
        """Get the total count of records."""
        query = f"SELECT COUNT(*) FROM {self.table}"
        return self._fetch_scalar(query) or 0


class MigrationManager:
    """Handles database schema migrations."""

    def __init__(self, db_connection: DatabaseConnection, migrations_dir: str = "modules/database/migrations"):
        self.db = db_connection
        self.migrations_dir = migrations_dir
        self.logger = db_connection.logger

    def get_current_version(self) -> int:
        """Get the current database version."""
        try:
            # Check if migrations table exists
            with self.db.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SHOW TABLES LIKE 'schema_migrations'")

                if cursor.rowcount == 0:
                    # Create migrations table
                    cursor.execute("""
                        CREATE TABLE schema_migrations (
                            version INT PRIMARY KEY,
                            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    conn.commit()
                    return 0

                # Get latest version
                cursor.execute("SELECT MAX(version) FROM schema_migrations")
                result = cursor.fetchone()
                return result[0] if result and result[0] is not None else 0

        except mariadb.Error as e:
            self.logger.error(f"Error checking migration version: {e}")
            return 0

    def run_migrations(self) -> bool:
        """Run all pending migrations."""
        try:
            current_version = self.get_current_version()
            migration_files = self._get_migration_files()

            pending_migrations = [
                (version, filename) for version, filename in migration_files
                if version > current_version
            ]

            if not pending_migrations:
                self.logger.info("No pending migrations")
                return True

            with self.db.get_connection() as conn:
                cursor = conn.cursor()

                for version, filename in pending_migrations:
                    self.logger.info(f"Running migration {version}: {filename}")

                    # Read and execute migration file
                    filepath = os.path.join(self.migrations_dir, filename)
                    with open(filepath, 'r') as f:
                        migration_sql = f.read()

                    # Execute migration
                    for statement in migration_sql.split(';'):
                        statement = statement.strip()
                        if statement and not statement.startswith('--'):
                            cursor.execute(statement)

                    # Record migration
                    cursor.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
                    conn.commit()

                    self.logger.info(f"Completed migration {version}")

            return True

        except Exception as e:
            self.logger.error(f"Migration failed: {e}", exc_info=True)
            return False

    def _get_migration_files(self) -> List[Tuple[int, str]]:
        """Get list of migration files sorted by version."""
        migrations = []

        if not os.path.exists(self.migrations_dir):
            self.logger.warning(f"Migrations directory not found: {self.migrations_dir}")
            return migrations

        for filename in os.listdir(self.migrations_dir):
            if filename.endswith('.sql'):
                try:
                    version = int(filename.split('.')[0])
                    migrations.append((version, filename))
                except ValueError:
                    self.logger.warning(f"Invalid migration filename: {filename}")

        return sorted(migrations)
