# claude-bridge: OpenAI 호환 /v1/chat/completions → Claude 구독(Claude Agent SDK, CLAUDE_CODE_OAUTH_TOKEN).
# 테스트용 — 유료 API 키 없이 agents-k / agents-group이 Claude를 LLM으로 사용 (LLM_PROVIDER=openai).
# build context: infra/claude-bridge
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Claude Code CLI(SDK 번들)는 HOME/.claude에 쓰기 가능해야 함
RUN useradd --create-home --uid 10003 bridge
USER bridge

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
