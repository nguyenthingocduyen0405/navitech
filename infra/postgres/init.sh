#!/bin/bash
# Runs once, on the first start of an empty Postgres volume.
# One database + one owner per service, so a leak in one service does not expose the others.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE USER keycloak WITH PASSWORD '${KEYCLOAK_DB_PASSWORD}';
    CREATE DATABASE keycloak OWNER keycloak;

    CREATE USER openwebui WITH PASSWORD '${OPENWEBUI_DB_PASSWORD}';
    CREATE DATABASE openwebui OWNER openwebui;

    CREATE USER app WITH PASSWORD '${APP_DB_PASSWORD}';
    CREATE DATABASE app OWNER app;
EOSQL

# pgvector for the RAG store
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname app -c "CREATE EXTENSION IF NOT EXISTS vector;"
