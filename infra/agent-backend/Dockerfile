# Agent backend (agent-backend/backend, LangGraph + Ollama Cloud) 이미지.
# 한 이미지로 두 Agent System을 띄웁니다 — docker-compose.yml의 agents-k / agents-group.
# build context: agent-backend/backend
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

# 회의록 · 회의 결과 보고서 PDF의 한글 글꼴 (나눔명조 · 나눔고딕). 이 VM은 외부 :80이 막혀 있어 apt도 https로 받는다
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends fonts-nanum && rm -rf /var/lib/apt/lists/*

# 의존성은 pyproject.toml의 [project].dependencies 그대로 설치 (코드 변경 시 이 층은 캐시됨)
COPY pyproject.toml .
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))" > /tmp/requirements.txt \
 && pip install --no-cache-dir -r /tmp/requirements.txt

COPY app ./app

RUN useradd --system --uid 10002 agents
USER agents

EXPOSE 8000 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
