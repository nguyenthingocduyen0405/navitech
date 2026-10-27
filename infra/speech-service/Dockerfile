# speech-service: 화자 식별 STT(Open WebUI의 STT 엔진) + 음성 등록 페이지(/voice/).
# 모델 파일은 이미지에 넣지 않고 ./models를 읽기 전용으로 마운트한다 (download_models.sh로 받음).
# build context: infra/speech-service
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# 이 VM은 외부 :80이 막혀 있어 apt도 https로 받는다
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py speech.py store.py ./
COPY static ./static

RUN useradd --system --uid 10004 speech
USER speech

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
