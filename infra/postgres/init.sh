#!/bin/bash
# 빈 Postgres 볼륨으로 처음 시작할 때 한 번만 실행됩니다.
# 서비스마다 DB와 소유 계정을 따로 두어, 한 서비스가 뚫려도 다른 서비스 데이터는 노출되지 않게 합니다.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE USER keycloak WITH PASSWORD '${KEYCLOAK_DB_PASSWORD}';
    CREATE DATABASE keycloak OWNER keycloak;

    CREATE USER openwebui WITH PASSWORD '${OPENWEBUI_DB_PASSWORD}';
    CREATE DATABASE openwebui OWNER openwebui;

    CREATE USER app WITH PASSWORD '${APP_DB_PASSWORD}';
    CREATE DATABASE app OWNER app;

    CREATE USER speech WITH PASSWORD '${SPEECH_DB_PASSWORD}';
    CREATE DATABASE speech OWNER speech;

    CREATE USER agents_k WITH PASSWORD '${AGENTS_K_DB_PASSWORD}';
    CREATE USER agents_group WITH PASSWORD '${AGENTS_GROUP_DB_PASSWORD}';
    CREATE DATABASE agents;

    -- 기본값은 모든 계정이 모든 DB에 접속 가능: 소유 계정만 접속하게 한다
    REVOKE CONNECT, TEMPORARY ON DATABASE keycloak, openwebui, app, speech FROM PUBLIC;
EOSQL

# RAG 저장소용 pgvector 확장
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname app -c "CREATE EXTENSION IF NOT EXISTS vector;"

# speech-service voiceprint 저장소 (화자 임베딩)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname speech -c "CREATE EXTENSION IF NOT EXISTS vector;"

# agent-backend 회의 저장소: Agent System마다 schema와 role을 따로 둔다 (Group은 K전자 회의 기록을 읽을 수 없음).
# 테이블은 agent-backend가 처음 쓸 때 만든다 (backend/app/library/workflows/meeting_schema.sql).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname agents <<-EOSQL
    REVOKE ALL ON DATABASE agents FROM PUBLIC;
    GRANT CONNECT ON DATABASE agents TO agents_k, agents_group;
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
    CREATE SCHEMA kelec AUTHORIZATION agents_k;
    CREATE SCHEMA grp AUTHORIZATION agents_group;
    ALTER ROLE agents_k IN DATABASE agents SET search_path = kelec, public;
    ALTER ROLE agents_group IN DATABASE agents SET search_path = grp, public;
EOSQL
