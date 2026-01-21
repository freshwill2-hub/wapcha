# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 파일 수정 규칙

**중요: 모든 파일 수정 전에 반드시 백업을 생성할 것**

- 백업 경로: `./backup/YYYYMMDD_HHMMSS/`
- 예: `./backup/20260121_143052/server.js`
- 백업 완료 후에만 수정 진행
- **백업 없이는 절대 파일 수정하지 말 것**

### 백업 명령어 예시
```bash
# 백업 폴더 생성
mkdir -p ./backup/$(date +%Y%m%d_%H%M%S)

# 파일 복사
cp server.js ./backup/$(date +%Y%m%d_%H%M%S)/
```

## 프로젝트 개요

Copychu Scraper - 올리브영 제품을 수집하여 Shopify에 업로드하는 파이프라인 시스템

## 주요 컴포넌트

### Phase 파일 (순차 실행)
- `phase0-url-collector.js` - 올리브영 카테고리에서 제품 URL 수집
- `phase1-main-gallery.js` - 제품 상세 정보 스크래핑
- `phase2-ai-generate.js` - 배경 제거 (rembg)
- `phase3-multi-3products.js` - AI 크롭 (Gemini)
- `phase4-final-data.js` - 이미지 선별 및 최적화
- `phase5-shopify-upload.js` - Shopify 업로드

### Dashboard
- `copychu-dashboard/server.js` - Express + Socket.io 서버
- `copychu-dashboard/public/` - 대시보드 UI (HTML/JS)

## 실행 명령어

```bash
# 대시보드 서버 (PM2)
pm2 restart copychu-dashboard
pm2 logs copychu-dashboard

# 개별 Phase 실행
node phase0-url-collector.js "카테고리URL" [최대개수] [최대페이지]
node phase1-main-gallery.js
node phase2-ai-generate.js
node phase3-multi-3products.js
node phase4-final-data.js
node phase5-shopify-upload.js
```

## 환경 변수 (.env)

- `NOCODB_API_URL`, `NOCODB_API_TOKEN` - NocoDB 연결
- `OLIVEYOUNG_TABLE_ID`, `SHOPIFY_TABLE_ID` - 테이블 ID
- `SHOPIFY_STORE_URL`, `SHOPIFY_ACCESS_TOKEN` - Shopify API
- `GOOGLE_GEMINI_API_KEY` - Gemini AI
- `OPENAI_API_KEY` - OpenAI (번역용)

## 로그 시스템

- 로그 경로: `./logs/`
- 개별 로그: `phase{N}_{YYYYMMDD_HHMMSS}.log`
- 통합 로그: `pipeline_{YYYYMMDD_HHMMSS}.log`
- 시간대: Australia/Sydney
- 보관 기간: 5일

## 주의사항

- Python 가상환경 경로: `/root/copychu-scraper/rembg-env/`
- rembg는 GPU 없이 CPU로 동작
- Shopify API Rate Limit 주의 (2초 간격 권장)
