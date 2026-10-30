# speech-service — 화자 식별 STT + 음성 등록

회의 녹음을 **발언자 이름이 붙은 transcript**로 바꿔 회의지원 Agent에 넘긴다.

```
직원: https://jbnunavitech.me:17227/voice/  (Keycloak 로그인) → 3문장 녹음 → voiceprint(192차원)만 DB `speech`에 암호화 저장
회의: Open WebUI 채팅에 녹음 파일 업로드 → Open WebUI STT(openai 호환) → POST /v1/audio/transcriptions
      → VAD(silero) → 구간별 화자 임베딩(CAM++) ↔ voiceprint 코사인 비교 → 텍스트(Groq Whisper | 로컬 SenseVoice)
      → "[03:12] 박지훈 (CFO): ..." 형식 transcript → 메시지에 포함되어 Agent로 전달
```

- 화자는 항상 VAD 구간에서 판정하고, STT 엔진은 텍스트만 만든다. 기준(`VOICE_MATCH_THRESHOLD`, 기본 0.5) 미만은 `미확인 화자 N`(미확인끼리 군집).
- 1초 미만 구간은 시간상 가장 가까운 구간의 화자를 따른다. 2분 이하·화자 1명(채팅 마이크)은 라벨 없이 일반 텍스트.
- STT 엔진: `GROQ_API_KEY`가 있으면 Groq `whisper-large-v3-turbo`, 없으면 로컬 SenseVoice(한국어 띄어쓰기가 가끔 깨짐 — 예비용).
- 개인정보: 녹음 원본은 디스크에 쓰지 않는다. 동의 체크 없이는 등록 불가, 본인이 페이지에서 삭제 가능.
  voiceprint는 AES-256-GCM으로 암호화해 저장한다(개인정보의 안전성 확보조치 기준 제7조). 키는 `.env`의 `VOICEPRINT_KEY`(`openssl rand -base64 32`)에만 있고, 키가 없으면 서비스가 시작되지 않는다. 키를 잃으면 전원 재등록.
  `/voice/api/test`는 "본인 목소리로 인식되는가"만 답한다 (다른 사람 이름·점수는 반환하지 않음).
- `/v1`은 docker 네트워크 안에서만 (nginx는 `/voice/`만 노출). 인증: `Bearer SPEECH_API_KEY`.
- 화자 라벨이 붙은 회의 transcript는 `transcripts` 테이블에 `TRANSCRIPT_RETENTION_DAYS`(기본 30일) 동안 보관하고, 텍스트 첫 줄에 `[transcript_id: TR-…]`를 붙인다.
  회의지원 Agent가 이 id로 `GET /internal/transcripts/{id}`(같은 키, 내부망)에서 발언 단위 결과를 가져가 자기 저장소에 따로 보관한다. 만료분은 매시간 삭제.

설치: `./download_models.sh` (모델 ~200MB → `models/`, 읽기 전용 마운트). 임베딩 모델을 바꾸면 기존 voiceprint는 재등록 대상(`outdated`).

검증 (2026-10-25, 합성 음성 3명 + 미등록 1명, 98초 회의): 구간 20/21 화자 정답, 처리 6초(RTF 0.06, 로컬 엔진).
실제 사람 목소리·회의실 마이크로 기준값을 다시 맞춰야 한다.
