# Open WebUI 녹음 파일 보존 기간 작업 (retention.py). docker-compose.yml의 retention 서비스.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir "psycopg[binary]>=3.2,<4"
WORKDIR /srv
COPY retention.py .
# Open WebUI 업로드 파일(root 소유)을 지워야 하므로 root로 실행합니다. 볼륨은 이 작업만 씁니다.
CMD ["python", "retention.py"]
