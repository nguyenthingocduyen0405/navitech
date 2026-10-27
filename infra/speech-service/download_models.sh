#!/bin/bash
# speech-service 모델 다운로드 (sherpa-onnx 릴리스). 이미 있으면 건너뜀. 약 260MB.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models && cd models
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
[ -f silero_vad.onnx ] || curl -fsSL -o silero_vad.onnx "$B/asr-models/silero_vad.onnx"
# 화자 임베딩: 3D-Speaker CAM++ (zh+en 대규모 학습, 192차원). 바꾸면 기존 voiceprint는 재등록 필요
[ -f campplus.onnx ] || curl -fsSL -o campplus.onnx "$B/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
# 로컬 STT (Groq 키가 없을 때): SenseVoice int8, 한국어 포함
if [ ! -d sense-voice ]; then
  curl -fsSL "$B/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" | tar xj
  mv sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17 sense-voice
  rm -rf sense-voice/test_wavs
fi
ls -la . sense-voice
