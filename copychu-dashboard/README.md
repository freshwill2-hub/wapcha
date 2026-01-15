# 🚀 Copychu Dashboard

올리브영 제품 이미지 자동화 시스템을 위한 웹 기반 대시보드입니다.

## ✨ 주요 기능

### 📊 대시보드
- 시스템 상태 실시간 모니터링
- 처리 통계 (총 제품, 완료, 비용)
- 빠른 실행 버튼 (3개, 10개, 50개, 100개)
- 최근 처리 제품 미리보기

### ▶️ 파이프라인 관리
- 원클릭 전체 파이프라인 실행
- 개별 Phase 선택 실행
- 처리 수량 조절 (1~1000개)
- 일시정지/재개/중지 기능

### 📺 실시간 모니터링
- 실시간 로그 스트리밍
- 성공/실패/API 호출 통계
- 예상 비용 실시간 계산
- Phase별 진행 상황 표시

### 🖼️ 이미지 갤러리
- 처리 완료 제품 미리보기
- 실패한 제품 목록
- 재처리 기능

### 📈 통계 및 비용
- 총 실행 횟수 및 성공률
- API 호출 횟수 및 비용
- 실행 이력 조회

### ⚙️ 설정
- 기본 처리 수량 설정
- 올리브영 URL 설정
- 이미지 품질 설정
- 스케줄 관리 (Cron)

---

## 📦 설치 방법

### 1. 파일 업로드

대시보드 폴더를 서버에 업로드합니다:

```bash
# 서버의 copychu-scraper 폴더에 업로드
cd /root/copychu-scraper
# copychu-dashboard 폴더 업로드
```

### 2. 환경 변수 설정

```bash
cd /root/copychu-scraper/copychu-dashboard

# .env 파일 생성
cp .env.example .env

# .env 파일 편집
nano .env
```

`.env` 파일을 다음과 같이 수정:

```env
DASHBOARD_PORT=3000
NOCODB_API_URL=http://77.42.67.165:8080
NOCODB_API_TOKEN=your_actual_token
OLIVEYOUNG_TABLE_ID=mufuxqsjgqcvh80
SHOPIFY_TABLE_ID=your_shopify_table_id
GOOGLE_GEMINI_API_KEY=your_gemini_key
SCRIPTS_DIR=/root/copychu-scraper
```

### 3. 의존성 설치

```bash
npm install
```

### 4. 서버 실행

```bash
# 일반 실행
npm start

# 또는 백그라운드 실행 (PM2 사용 권장)
pm2 start server.js --name copychu-dashboard

# 개발 모드 (파일 변경 시 자동 재시작)
npm run dev
```

### 5. 접속

브라우저에서 접속:
- 로컬: `http://localhost:3000`
- 외부: `http://서버IP:3000`

---

## 🔧 기존 스크립트 수정

기존 Phase 스크립트들이 대시보드와 호환되려면, 환경 변수에서 `PRODUCT_LIMIT`을 읽도록 수정해야 합니다.

각 스크립트 상단에 다음을 추가:

```javascript
// 대시보드 호환: 환경 변수에서 수량 읽기
const PRODUCT_LIMIT = parseInt(process.env.PRODUCT_LIMIT) || 3;
```

그리고 기존의 하드코딩된 limit 값을 `PRODUCT_LIMIT`으로 변경합니다.

### 수정이 필요한 파일들:

1. **phase1-main-gallery.js**
   ```javascript
   // 변경 전
   const products = await getOliveyoungProducts(3, 0);
   
   // 변경 후
   const PRODUCT_LIMIT = parseInt(process.env.PRODUCT_LIMIT) || 3;
   const products = await getOliveyoungProducts(PRODUCT_LIMIT, 0);
   ```

2. **phase2-ai-generate-improved.js**
   ```javascript
   // 변경 전
   const limit = 3;
   
   // 변경 후
   const limit = parseInt(process.env.PRODUCT_LIMIT) || 3;
   ```

3. **phase2_5-final-multi-3products.js**
   ```javascript
   // 변경 전
   params: { limit: 3, ... }
   
   // 변경 후
   const PRODUCT_LIMIT = parseInt(process.env.PRODUCT_LIMIT) || 3;
   params: { limit: PRODUCT_LIMIT, ... }
   ```

4. **phase2.6-with-naver-supplement-v4.js**
   ```javascript
   // 변경 전
   params: { limit: 3, ... }
   
   // 변경 후
   const PRODUCT_LIMIT = parseInt(process.env.PRODUCT_LIMIT) || 3;
   params: { limit: PRODUCT_LIMIT, ... }
   ```

---

## 📅 스케줄 예시

### Cron 표현식 가이드

| 표현식 | 설명 |
|--------|------|
| `0 9 * * *` | 매일 오전 9시 |
| `0 9,18 * * *` | 매일 오전 9시, 오후 6시 |
| `0 */6 * * *` | 6시간마다 |
| `0 9 * * 1-5` | 평일 오전 9시 |
| `0 0 * * 0` | 매주 일요일 자정 |

### 추천 스케줄

- **매일 오전 9시, 100개 처리**: `0 9 * * *`
- **평일 오전/오후 각 50개**: `0 9,18 * * 1-5`
- **주말 대량 처리 (500개)**: `0 3 * * 0`

---

## 💰 비용 계산

| 항목 | 단가 | 비고 |
|------|------|------|
| Gemini 2.0 Flash | $0.0001/이미지 | 이미지 분석 |
| 제품당 평균 API 호출 | ~10회 | 크롭, 평가, 검증 |
| 제품당 비용 | ~$0.001 | 약 1원 |
| 1,000개 처리 | ~$1.00 | 약 1,300원 |

---

## 🐛 문제 해결

### 서버가 시작되지 않을 때

```bash
# 포트 확인
lsof -i :3000

# 다른 포트 사용
DASHBOARD_PORT=3001 npm start
```

### Socket.io 연결 실패

- 방화벽에서 포트 열기: `ufw allow 3000`
- 브라우저 콘솔에서 WebSocket 오류 확인

### Phase 실행 실패

- `SCRIPTS_DIR` 경로 확인
- 각 Phase 스크립트 권한 확인: `chmod +x *.js`
- Node.js 버전 확인: `node -v` (18+ 권장)

---

## 📝 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/state` | 현재 시스템 상태 |
| GET | `/api/config` | 설정 조회 |
| POST | `/api/config` | 설정 저장 |
| POST | `/api/pipeline/start` | 파이프라인 시작 |
| POST | `/api/pipeline/pause` | 일시정지 |
| POST | `/api/pipeline/resume` | 재개 |
| POST | `/api/pipeline/stop` | 중지 |
| POST | `/api/pipeline/run-phase` | 단일 Phase 실행 |
| GET | `/api/logs` | 로그 조회 |
| GET | `/api/stats` | 통계 조회 |
| GET | `/api/products/recent` | 최근 처리 제품 |
| GET | `/api/products/failed` | 실패 제품 |
| GET | `/api/schedules` | 스케줄 목록 |
| POST | `/api/schedules` | 스케줄 추가 |
| DELETE | `/api/schedules/:id` | 스케줄 삭제 |

---

## 🔮 향후 업데이트 예정

- [ ] 특정 제품 재처리 기능
- [ ] 이미지 수동 교체 기능
- [ ] 처리 결과 내보내기 (CSV, Excel)
- [ ] 이메일/Slack 알림
- [ ] 다크/라이트 테마 전환
- [ ] 모바일 반응형 개선

---

## 📞 지원

문의사항이 있으시면 언제든 연락주세요!

---

Made with ❤️ for Copychu Automation System
