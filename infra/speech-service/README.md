# speech-service — 화자 식별 STT + 음성 등록

회의 녹음을 **발언자 이름이 붙은 transcript**로 바꿔 회의지원 Agent에 넘긴다.

```
직원: https://jbnunavitech.me:17227/voice/  (Keycloak 로그인) → 3문장 녹음 → voiceprint(192차원)만 DB `speech`에 암호화 저장
회의: Open WebUI 채팅에 녹음 파일 업로드 → Open WebUI STT(openai 호환) → POST /v1/audio/transcriptions
      → VAD(silero) → 구간별 화자 임베딩(CAM++) ↔ voiceprint 코사인 비교 → 텍스트(Groq Whisper | 로컬 SenseVoice)
      → "[03:12] 박지훈 (CFO): ..." 형식 transcript → 메시지에 포함되어 Agent로 전달
```

- 화자는 항상 VAD 구간에서 판정하고, STT 엔진은 텍스트만 만든다. 녹음 전체의 구간을 한꺼번에 군집(평균 연결,
  `SPEAKER_CLUSTER_THRESHOLD` 기본 0.45)하고, 말한 양이 녹음의 2%(최대 30초)도 안 되는 군집은 가장 가까운 화자에 합친다.
  군집의 평균 목소리가 voiceprint와 기준(`VOICE_MATCH_THRESHOLD`, 기본 0.5) 이상 닮으면 그 이름, 아니면 처음 말한 순서대로
  `화자 A` · `화자 B` …(같은 글자 = 같은 목소리). 아무도 등록하지 않았어도 회의 전체가 이렇게 나뉘어 회의록이 만들어진다.
- 1초 미만 구간은 시간상 가장 가까운 구간의 화자를 따른다. 2분 이하·화자 1명(채팅 마이크)은 라벨 없이 일반 텍스트.
- STT 엔진: `GROQ_API_KEY`가 있으면 Groq `whisper-large-v3-turbo`, 없으면 로컬 SenseVoice(한국어 띄어쓰기가 가끔 깨짐 — 예비용).
- 개인정보: 녹음 원본은 디스크에 쓰지 않는다. 동의 체크 없이는 등록 불가, 본인이 페이지에서 삭제 가능.
  voiceprint는 AES-256-GCM으로 암호화해 저장한다(개인정보의 안전성 확보조치 기준 제7조). 키는 `.env`의 `VOICEPRINT_KEY`(`openssl rand -base64 32`)에만 있고, 키가 없으면 서비스가 시작되지 않는다. 키를 잃으면 전원 재등록.
  `/voice/api/test`는 "본인 목소리로 인식되는가"만 답한다 (다른 사람 이름·점수는 반환하지 않음).
- `/v1`은 docker 네트워크 안에서만 (nginx는 `/voice/`만 노출). 인증: `Bearer SPEECH_API_KEY`.
- 화자 라벨이 붙은 회의 transcript는 `transcripts` 테이블에 `TRANSCRIPT_RETENTION_DAYS`(기본 30일) 동안 보관하고, 텍스트 첫 줄에 `[transcript_id: TR-…]`를 붙인다.
  회의지원 Agent가 이 id로 `GET /internal/transcripts/{id}`(같은 키, 내부망)에서 발언 단위 결과를 가져가 자기 저장소에 따로 보관한다. 만료분은 매시간 삭제.
- 회의에서 익힌 목소리 (2026-11-03): 이름을 찾지 못한 발언자(`화자 C`)마다 평균 목소리를 `speaker_samples`에 암호화해 `SPEAKER_SAMPLE_DAYS`(기본 7일) 동안 둔다.
  회의지원 Agent 사용자가 회의 카드에서 "화자 C = 누구"를 정하고, 그 사람이 녹음을 올릴 때 띄운 QR로 출석하면서 목소리 학습에 **본인이** 동의했으면
  `POST /internal/voiceprints/learn`(같은 키, 내부망)이 그 목소리를 그 사람의 voiceprint(`source = 'meeting'`)로 저장한다 → 다음 회의부터 이름으로 적힌다.
  발언이 `VOICE_LEARN_MIN_SECONDS`(기본 30초)보다 짧으면 익히지 않고, `/voice/`에서 3문장으로 등록한 voiceprint는 바꾸지 않는다. 다시 확인되면 이전 회의 목소리와 평균한다.
  누구인지 정해지지 않은 목소리는 기간이 지나면 삭제된다. 본인은 `/voice/`에서 확인 · 삭제할 수 있다.
- 목소리 구분 확인 (2026-11-03): gateway의 `/meetings/voice-check/`(회의지원 Agent 권한)가 녹음을 `POST /internal/review`(같은 키)로 보내면
  회의 녹음과 같은 방식으로 처리해 job id를 주고, `GET /internal/review/{job}?owner=`로 결과(발언 · 발언자별 시간 · 일치도, 이름이 없는 목소리는
  가장 가까운 등록 목소리와 일치도)를 준다. transcript로 보관하지 않고 `speaker_samples`도 남기지 않으며, 결과는 메모리에 1시간(`REVIEW_KEEP_SECONDS`).
  동시에 2개까지 받고, 회의 녹음과 같은 작업 잠금을 써서 앞선 작업이 끝난 뒤 시작한다.
- 발언자를 나누는 방식 `DIARIZATION` (2026-11-03): `vad`(기본, 말소리 구간을 목소리로 묶기) | `pyannote`(sherpa-onnx 화자 분리: pyannote
  segmentation-3.0이 10초 창마다 말하는 사람이 바뀌는 곳 · 겹치는 곳을 찾고 CAM++로 묶은 뒤, 말소리 구간을 그 자리에서 다시 자름). 이름 붙이기 ·
  voiceprint · 학습은 두 방식이 같다. 목소리 구분 확인 화면에서 같은 녹음을 두 방식으로 돌려 비교할 수 있다 (`method=`). 모델은 `download_models.sh`
  (`models/pyannote-segmentation/`). `PYANNOTE_CLUSTER_THRESHOLD`(0.5, 클수록 사람 수가 적게), `PYANNOTE_WINDOW_SHIFT`(0.1 = pyannote 기본;
  5분 발췌에서 0.25 · 0.5는 빨라지지만 한 사람의 긴 발언을 둘로 나눔). 로컬 PC 5분 발췌: vad 28–40초, pyannote 84–177초.

설치: `./download_models.sh` (모델 ~200MB → `models/`, 읽기 전용 마운트). 임베딩 모델을 바꾸면 기존 voiceprint는 재등록 대상(`outdated`).

검증 (2026-10-25, 합성 음성 3명 + 미등록 1명, 98초 회의): 구간 20/21 화자 정답, 처리 6초(RTF 0.06, 로컬 엔진).
실제 사람 목소리·회의실 마이크로 기준값을 다시 맞춰야 한다.
