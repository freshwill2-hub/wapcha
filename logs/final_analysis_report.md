# Copychu Scraper - 이미지 품질 종합 분석 리포트

**분석일:** 2026-02-14
**분석자:** Claude Code (자동화 분석)
**분석 범위:** Shopify 업로드된 80개 제품, 157개 이미지 전수 + NocoDB 파이프라인 데이터 100개 레코드

---

## 1. Executive Summary

| 지표 | 수치 | 비고 |
|---|---|---|
| 올리브영 수집 | 100개 | Phase0+1 |
| Phase2 통과 (rembg) | 100/100 (100%) | 배경 제거 성공 |
| Phase3 통과 (Gemini) | 92/100 (92%) | 8개 전량 SKIP |
| Phase4 main_image 선정 | 80/100 (80%) | 12개 점수 미달 |
| Phase5 Shopify 업로드 | 80/80 (100%) | 업로드 자체는 성공 |
| **이미지 품질 합격** | **16/80 (20%)** | **80% 문제 있음** |

**핵심 결론:** 파이프라인은 기술적으로 작동하지만, 업로드된 이미지의 80%에 품질 문제가 존재. 주요 원인은 rembg 잔여물(#1), 올리브영 프로모 배지 미제거(#2), 번역 오류(#3) 순.

---

## 2. 이미지 품질 분석 (Step 3 결과)

### 2.1 배치별 결과

| 배치 | 범위 | 문제 | 정상 | 문제율 |
|---|---|---|---|---|
| 1 | p1~p10 | 8 | 2 | 80% |
| 2 | p11~p20 | 9 | 1 | 90% |
| 3 | p21~p30 | 8 | 2 | 80% |
| 4 | p31~p40 | 9 | 1 | 90% |
| 5 | p41~p50 | 8 | 2 | 80% |
| 6 | p51~p60 | 7 | 3 | 70% |
| 7 | p61~p70 | 7 | 3 | 70% |
| 8 | p71~p80 | 8 | 2 | 80% |
| **합계** | **p1~p80** | **64** | **16** | **80%** |

### 2.2 기준별 발생 빈도

| 순위 | 기준 | 발생건수 | 심각도 | 책임 Phase |
|---|---|---|---|---|
| 1 | [8] rembg 잔여물 | ~45건 | HIGH | Phase2 |
| 2 | [3] 배너/광고/배지 | ~30건 | HIGH | Phase3/4 |
| 3 | [1] 타이틀 불일치 | ~20건 | MEDIUM | Phase1 |
| 4 | [5] 프로모션 세트 | ~18건 | HIGH | Phase3/4 |
| 5 | [2] 사이드 제품/증정품 | ~15건 | MEDIUM | Phase3/4 |
| 6 | [4] 크롭 실패 | ~15건 | MEDIUM | Phase3 |
| 7 | [7] 포장박스만 | ~12건 | HIGH | Phase3/4 |
| 8 | [11] 중복 이미지/제품 | ~8건 | LOW | Phase0/1 |
| 9 | [6] 모델/사람/손 | ~4건 | LOW | Phase3 |
| 10 | [9] 이미지 품질 | ~2건 | LOW | Phase2 |
| 11 | [10] 빈 이미지 | 0건 | - | - |
| 12 | [12] 네이버 오염 | 0건 | - | - |

### 2.3 정상 제품 (16개) - 이미지 품질 합격

| # | 제품명 | 브랜드 특성 |
|---|---|---|
| p7 | AHC Youth Lasting Serum | 글로벌 브랜드 |
| p10 | Anua Heartleaf 80% Soothing Ampoule | K-beauty 히트상품 |
| p15 | CNP Laboratory Propolis Ampoule | 제약 브랜드 |
| p26 | innisfree Retinol Cica Trace Ampoule | 글로벌(아모레) |
| p28 | Isntree Hyaluronic Acid Water Essence | 인디 브랜드 |
| p35 | La Roche-Posay Effaclar Ultra Concentrated | 글로벌 브랜드 |
| p42 | La Roche-Posay Effaclar Duo+M | 글로벌 브랜드 |
| p43 | Laneige Water Bank Blue Hyaluronic | 글로벌(아모레) |
| p53 | Mixsoon Hyalebae Pore Bubble Serum | 인디 브랜드 |
| p55 | numbuzin Blur Powder (메인만) | 깨끗한 메인 |
| p58 | Parnell Cica Manu 92 Serum | 콜라보에디션 |
| p59 | primera PDRN-Niacinamide 10 | 프리미엄(아모레) |
| p60 | primera Vita-Tinol Bouncy Lift | 프리미엄(아모레) |
| p62 | Rejuran Healer Turnover Ampoule | 프리미엄 브랜드 |
| p66 | SKIN1004 Madagascar Centella | 글로벌 인디 |
| p70 | The Ordinary Niacinamide | 글로벌 브랜드 |
| p72 | The Ordinary Retinol | 글로벌 브랜드 |
| p74 | Torriden Dive In (메인만) | 인디 히트상품 |

**패턴:** 글로벌 브랜드(La Roche-Posay, The Ordinary, 아모레퍼시픽 계열)는 원본 이미지 자체가 깨끗하여 파이프라인 통과 후에도 양호. 로컬 브랜드 + 올리브영 프로모 이미지가 주요 문제원.

---

## 3. 파이프라인 실패 분석 (Step 4)

### 3.1 파이프라인 통과율

```
Phase0+1: 100개 수집
    ↓ Phase2 (rembg): 100/100 통과 (100%) - 배경제거 기술적 성공
    ↓ Phase3 (Gemini): 92/100 통과 (92%) - 8개 SKIP 처리
    ↓ Phase4 (스코어링): 80/100 main_image (80%) - 12개 점수미달
    ↓                    55/100 gallery_images (55%) - 25개 갤러리 없음
    ↓ Phase5 (업로드): 80/80 성공 (100%)
```

### 3.2 Phase3 실패 (8개) - Gemini가 전량 SKIP

| 제품명 | 실패 원인 추정 |
|---|---|
| numbuzin No.3 Soft & Smooth Silk Serum | 프로모 이미지만 존재 |
| Partyon Noskanine Trouble Serum | 이미지 품질 미달 |
| innisfree Vitamin C Capsule Serum | 세트 이미지만 존재 |
| Ongreedients Green Tomato NMN Ampoule | 프로모/배지 이미지 |
| VT PRDN Essence 100 30ml | 프로모 이미지 |
| AmpouleN Ceramide Shot | 이미지 품질 미달 |
| Aestura Atobarrier 365 Hydro Essence | 프로모 이미지 |
| Wellage Real Hyaluronic One Day Kit | 키트 구성 이미지 |

### 3.3 Phase4 실패 (12개) - 점수 미달 (MIN_SCORE_FOR_MAIN=35)

모든 이미지가 35점 미만 → rembg 잔여물 + 프로모 요소로 Gemini 스코어링에서 감점.

### 3.4 Gallery 없음 (25개) - main은 있으나 gallery 없음

Phase4에서 MIN_SCORE_FOR_GALLERY=60점 이상인 이미지가 없어 main(35점 이상)만 선택됨.
→ 업로드된 80개 중 25개(31%)가 단일 이미지만 보유.

---

## 4. 데이터 플로우 검증 (Step 5)

### 4.1 중복 제품 등록

| 제품명 | 중복수 | 원인 |
|---|---|---|
| Torriden Dive In Hyaluronic Acid Serum 50ml | 3중복 | Phase0 URL 중복수집 |
| Abib Mugwort Tecca Capsule Serum 50ml 2pcs | 2중복 | 동일 |
| Aestura Atobarrier 365 Hydro Essence 200ml | 2중복 | 동일 |

**원인:** Phase0에서 올리브영 카테고리 페이지를 크롤링할 때, 같은 제품이 다른 URL 또는 같은 URL이 여러 카테고리에 노출되어 중복 수집됨. Phase1에서 SKU 기반 중복체크가 미작동하거나 미구현.

### 4.2 타이틀 번역 오류 패턴

| 패턴 | 예시 | 발생수 | 원인 |
|---|---|---|---|
| 고유명사 오번역 | "리들샷"→"Riddle Shot" (정확: REEDLE SHOT) | 3건 | OpenAI 번역 시 브랜드명 미인식 |
| 제품라인 혼동 | "윤조에센스"→"Yoonjo Essence" (정확: First Care Activating Serum VI) | 2건 | 한국어 마케팅명 직역 |
| 제품타입 오류 | "Ampoule"↔"Serum" 혼용 | 5건+ | 올리브영 표기와 실제 라벨 불일치 |
| 성분명 변형 | "Panthenol"→"Pantothenic B5" | 2건 | 동일 성분 다른 표기 |

### 4.3 OliveYoung→Shopify 필드 매핑

```
OliveYoung Table          Shopify Table
────────────────          ────────────────
product_images (6~10개) → ai_product_images (Phase2 후)
                        → validated_images (Phase3 후)
                        → main_image + gallery_images (Phase4 후)
title_kr                → title_en (OpenAI 번역)
description             → description_en (OpenAI 번역)
price_original          → price_aud (환율 변환)
```

**set_count 필드:** OliveYoung 테이블에 미저장. Phase1 코드에는 set_count 감지 로직이 있으나 NocoDB에 별도 필드로 저장하지 않고 Phase3에서 이미지 분석 시 재감지하는 구조.

---

## 5. Phase별 개선 권고사항

### Phase0 (URL 수집)
1. **URL 중복 체크 강화**: product_url 또는 goodsNo 기준 dedup 필수
2. **카테고리 간 중복 필터**: 동일 SKU가 여러 카테고리에 노출되는 경우 처리

### Phase1 (스크래핑)
1. **브랜드 영문명 매핑 테이블**: 고유명사(리들샷→REEDLE SHOT, 윤조에센스→First Care Activating Serum VI) 사전 구축
2. **set_count NocoDB 저장**: 세트 구성 정보를 별도 필드에 저장하여 Phase3/4에서 활용
3. **프로모 이미지 사전 필터**: 올리브영 이미지 URL에서 프로모/배너 이미지 패턴 감지

### Phase2 (rembg)
1. **rembg 모델 업그레이드**: u2net에서 IS-Net 또는 BiRefNet으로 교체 → 색상 윤곽 잔여물 대폭 감소
2. **후처리 파이프라인 추가**: rembg 출력 후 엣지 디텍션 → 색상 윤곽(초록/노란/파란) 자동 제거
3. **배지/고스트 감지**: rembg 후 이미지에서 반투명 영역 감지 → 배지 고스트 자동 제거

### Phase3 (Gemini 검증)
1. **한글 텍스트 감지 추가**: 이미지 내 한글 텍스트 존재 시 자동 SKIP 또는 CROP
2. **"+" 기호 감지**: 프로모 세트 표시인 "+" 기호 감지 → SKIP_PROMOTION
3. **포장박스 감지 강화**: 3D 박스 형태 감지 → SKIP_BOX
4. **배지 패턴 확장**: "올영PICK", "ONLY 올리브영", "GLOWPICK", "Slow Aging", "1+1", "더블기획" 등

### Phase4 (스코어링)
1. **rembg 잔여물 페널티**: 색상 윤곽/고스트 감지 시 큰 감점
2. **크롭 품질 검증**: 제품이 프레임 대비 너무 크거나 잘리면 감점
3. **해밍 거리 임계값 조정**: 현재 hamming≤10이 동일 이미지 감지에 불충분한 사례 존재 (p34)
4. **제품 간 이미지 중복 체크**: 다른 제품에 동일 이미지가 할당되는 경우 감지

### Phase5 (업로드)
1. **업로드 전 최종 품질 체크**: Shopify 업로드 직전 이미지 품질 최종 검증
2. **타이틀-라벨 정합성 체크**: 이미지 내 텍스트(OCR)와 타이틀 비교

---

## 6. 우선순위별 액션 아이템

### 즉시 (Quick Win)
1. Phase0에 URL dedup 로직 추가 → 중복 제품 3~7건 방지
2. Phase3 Gemini 프롬프트에 한글/배지/"+"/포장박스 감지 규칙 추가
3. 브랜드 영문명 매핑 JSON 파일 생성 (최소 20개 주요 브랜드)

### 단기 (1~2주)
4. rembg 후처리 - 색상 윤곽 제거 알고리즘 구현 (OpenCV edge detection)
5. Phase4 스코어링에 rembg 잔여물 감지 + 크롭 품질 + 포장박스 페널티 추가
6. Phase4에 제품 간 이미지 해시 중복 체크 추가

### 중기 (1개월)
7. rembg → BiRefNet 모델 교체 (GPU 필요 여부 검토)
8. Phase1 번역에 OCR 기반 라벨 검증 추가
9. Phase5 업로드 전 최종 QA 자동화

---

## 7. 상세 데이터 참조

- 이미지별 상세 분석: `/root/copychu-scraper/logs/image_analysis_results.md`
- Shopify 제품 데이터: `/root/copychu-scraper/logs/shopify_products.json`
- NocoDB Shopify 테이블: `mu6cjbedwo3m2tt` (100 레코드)
- NocoDB OliveYoung 테이블: `mfi4ic7zj2gfixv` (100 레코드)

---

*이 리포트는 파일 수정 없이 분석만 수행하였습니다.*
