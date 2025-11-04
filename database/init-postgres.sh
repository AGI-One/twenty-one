#!/bin/bash
set -e

# Create databases
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "default" WITH OWNER $POSTGRES_USER;
    CREATE DATABASE "test" WITH OWNER $POSTGRES_USER;
EOSQL

echo "Databases 'default' and 'test' have been created successfully."
