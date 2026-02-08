import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';
import FormData from 'form-data';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

// ==================== 로그 시스템 설정 ====================
const SYDNEY_TIMEZONE = 'Australia/Sydney';
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_RETENTION_DAYS = 5;  // ✅ 5일간만 로그 보관

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getSydneyTime() {
    return new Date().toLocaleString('en-AU', { 
        timeZone: SYDNEY_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function getSydneyTimeForFile() {
    const now = new Date();
    const sydneyDate = new Date(now.toLocaleString('en-US', { timeZone: SYDNEY_TIMEZONE }));
    const year = sydneyDate.getFullYear();
    const month = String(sydneyDate.getMonth() + 1).padStart(2, '0');
    const day = String(sydneyDate.getDate()).padStart(2, '0');
    const hour = String(sydneyDate.getHours()).padStart(2, '0');
    const min = String(sydneyDate.getMinutes()).padStart(2, '0');
    const sec = String(sydneyDate.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}_${hour}-${min}-${sec}`;
}

// ✅ 오래된 로그 자동 삭제 함수
function cleanupOldLogs() {
    const now = Date.now();
    const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const deletedFiles = [];
    try {
        const files = fs.readdirSync(LOG_DIR);
        for (const file of files) {
            if (!file.endsWith('.log')) continue;
            const filePath = path.join(LOG_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath);
                    deletedFiles.push(file);
                }
            } catch (error) {}
        }
    } catch (error) {}
    return deletedFiles;
}

// ✅ 시작 시 오래된 로그 삭제
const deletedLogs = cleanupOldLogs();

// ✅ 통합 로그 경로 (파이프라인 실행 시 설정됨)
const UNIFIED_LOG_PATH = process.env.UNIFIED_LOG_PATH || null;

const LOG_FILENAME = `phase1_${getSydneyTimeForFile()}.log`;
const LOG_PATH = path.join(LOG_DIR, LOG_FILENAME);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(...args) {
    const timestamp = `[${getSydneyTime()}]`;
    const message = args.join(' ');
    console.log(timestamp, message);
    logStream.write(`${timestamp} ${message}\n`);

    // ✅ 통합 로그에도 기록
    if (UNIFIED_LOG_PATH) {
        try {
            fs.appendFileSync(UNIFIED_LOG_PATH, `${timestamp} ${message}\n`);
        } catch (e) {
            // 통합 로그 기록 실패 시 무시
        }
    }
}

// ✅ 통합 로그에 Phase 시작 구분선 추가
if (UNIFIED_LOG_PATH) {
    const separator = '═══ PHASE 1: 스크래핑 시작 ═══';
    try {
        fs.appendFileSync(UNIFIED_LOG_PATH, `\n${separator}\n`);
    } catch (e) {
        // 무시
    }
}

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID || 'mfi4ic7zj2gfixv';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_VOLUME_LIMIT = parseInt(process.env.MAX_VOLUME_LIMIT) || 0;  // ✅ v2.9: 용량 제한 (ml), 0이면 무제한

// ✅ 메모리 관리 설정
const BATCH_SIZE = 10;
const MEMORY_CHECK_INTERVAL = 5;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

log('🚀 Phase 1: 제품 상세 스크래핑 (v2.9.2 - 배치 반복 처리 추가)');
log('='.repeat(70));
log('🔧 설정 확인:');
log(`- NocoDB URL: ${NOCODB_API_URL}`);
log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);
log(`- OpenAI API: ${OPENAI_API_KEY ? '✅ 설정됨' : '❌ 없음'}`);
log(`- 용량 제한: ${MAX_VOLUME_LIMIT > 0 ? MAX_VOLUME_LIMIT + 'ml' : '무제한'}`);  // ✅ v2.9
log(`- 시간대: ${SYDNEY_TIMEZONE} (시드니)`);
log(`- 로그 파일: ${LOG_PATH}`);
if (deletedLogs.length > 0) {
    log(`🧹 오래된 로그 ${deletedLogs.length}개 삭제됨 (${LOG_RETENTION_DAYS}일 이상)`);
}
log('');
log('🆕 v2.9.2 수정 사항:');
log('   ✅ 배치 반복 처리: 미처리 제품이 없을 때까지 자동 반복');
log('   ✅ 배치마다 크롤러 재생성 (메모리 관리)');
log('   ✅ PRODUCT_LIMIT = 배치 크기 (기본 20)');
log('   ✅ v2.9.1 기능 모두 유지');
log('');

// ==================== 전역 변수 ====================
let processedCount = 0;
let successCount = 0;
let skippedCount = 0;
let failedCount = 0;

const stats = {
    titleKrFilled: 0,
    titleEnFilled: 0,
    priceFilled: 0,
    descriptionFilled: 0,
    imagesFilled: 0,
    titleKrSkipped: 0,
    titleEnSkipped: 0,
    priceSkipped: 0,
    descriptionSkipped: 0,
    imagesSkipped: 0,
    imagesDownloadFailed: 0,
    images404Skipped: 0,
    // ✅ v2.7: 세트 감지 통계
    setDetected: 0,
    promotionalRemoved: 0,
    // ✅ v2.9: 용량 제한 통계
    volumeExceededSkipped: 0,
    // ✅ v2.9.1: product_url null 통계
    noUrlSkipped: 0
};

// ==================== 메모리 관리 함수 ====================
function getMemoryUsage() {
    const used = process.memoryUsage();
    return {
        rss: Math.round(used.rss / 1024 / 1024),
        heapTotal: Math.round(used.heapTotal / 1024 / 1024),
        heapUsed: Math.round(used.heapUsed / 1024 / 1024),
        external: Math.round(used.external / 1024 / 1024)
    };
}

function logMemoryUsage(label = '') {
    const mem = getMemoryUsage();
    log(`📊 메모리 ${label}: RSS=${mem.rss}MB, Heap=${mem.heapUsed}/${mem.heapTotal}MB`);
}

async function forceGarbageCollection() {
    if (global.gc) {
        global.gc();
        log('🧹 가비지 컬렉션 실행됨');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
}

// ==================== 필드 체크 함수 ====================
function checkMissingFields(product) {
    const missing = {
        needsTitleKr: !product.title_kr || product.title_kr.trim() === '',
        needsTitleEn: !product.title_en || product.title_en.trim() === '',
        needsPriceOriginal: !product.price_original || product.price_original === 0,
        needsPriceDiscount: !product.price_discount || product.price_discount === 0,
        needsDescription: !product.description || product.description.trim() === '',
        needsDescriptionEn: !product.description_en || product.description_en.trim() === '',
        needsImages: !product.product_images || product.product_images.length === 0
    };
    
    missing.needsPageVisit = missing.needsTitleKr || missing.needsPriceOriginal || 
                              missing.needsDescription || missing.needsImages;
    
    missing.isComplete = !missing.needsTitleKr && !missing.needsTitleEn && 
                         !missing.needsPriceOriginal && !missing.needsDescription &&
                         !missing.needsDescriptionEn && !missing.needsImages;
    
    return missing;
}

// ==================== ✅ v2.9: 용량 총합 계산 함수 ====================
function calculateTotalVolume(title) {
    if (!title) return 0;
    
    let totalVolume = 0;
    
    // 1. 개수 정보 추출 (예: "2개", "3입")
    const countMatch = title.match(/(\d+)\s*(개|입|매|pcs)/i);
    const productCount = countMatch ? parseInt(countMatch[1]) : 1;
    
    // 2. 모든 용량 추출 (ml, g 단위)
    const volumePattern = /(\d+)\s*(ml|mL|ML|g|G)/gi;
    const volumes = [];
    let match;
    
    while ((match = volumePattern.exec(title)) !== null) {
        const value = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        // g를 ml로 대략 변환 (밀도 ~1 가정, 화장품은 대체로 비슷)
        const mlValue = unit === 'g' ? value : value;
        volumes.push(mlValue);
    }
    
    // 3. 용량 합계 계산
    if (volumes.length === 0) {
        return 0;  // 용량 정보 없음
    } else if (volumes.length === 1) {
        // 단일 용량 × 개수
        totalVolume = volumes[0] * productCount;
    } else {
        // 여러 용량이 있으면 합산 (세트 제품)
        totalVolume = volumes.reduce((sum, v) => sum + v, 0);
        // 개수가 명시되어 있고 용량이 하나만 반복된 것 같으면 곱하기
        if (productCount > 1 && volumes.every(v => v === volumes[0])) {
            totalVolume = volumes[0] * productCount;
        }
    }
    
    return totalVolume;
}

// ==================== ✅ v2.8.2: 개선된 타이틀 클리닝 함수 ====================
function cleanProductTitle(rawTitle) {
    if (!rawTitle) return '';
    
    let cleaned = rawTitle;
    let setInfo = null;
    
    log(`   🔍 타이틀 클리닝 시작: "${cleaned.substring(0, 80)}..."`);
    
    // STEP 0: 문자열 정규화
    cleaned = cleaned.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    // STEP 1: "| 올리브영" 또는 "- 올리브영" 제거
    cleaned = cleaned.replace(/\s*[\|｜]\s*올리브영.*$/g, '');
    cleaned = cleaned.replace(/\s*[-–—]\s*올리브영.*$/g, '');
    cleaned = cleaned.replace(/\s+올리브영\s*$/g, '');
    cleaned = cleaned.replace(/^\s*올리브영\s*[\|｜\-–—]\s*/g, '');
    
    // ==================== STEP 1.4: ✅ v2.11 대괄호 내 세트 패턴 먼저 감지 ====================
    const bracketContents = cleaned.match(/\[([^\]]*)\]/g) || [];
    for (const bracket of bracketContents) {
        const inner = bracket.slice(1, -1);

        const nplusMatch = inner.match(/(\d)\s*\+\s*(\d)/);
        if (nplusMatch) {
            const n1 = parseInt(nplusMatch[1]);
            const n2 = parseInt(nplusMatch[2]);
            const total = n1 + n2;
            if (!setInfo && total >= 2 && total <= 6) {
                setInfo = { volume: null, count: total, type: 'bracket_plus' };
                log(`   ✅ 세트 감지 (대괄호 내 ${n1}+${n2}): ${total}개`);
                stats.setDetected++;
            }
        }

        if (!setInfo && /더블|듀블/i.test(inner)) {
            setInfo = { volume: null, count: 2, type: 'bracket_double' };
            log(`   ✅ 세트 감지 (대괄호 내 더블): 2개`);
            stats.setDetected++;
        }
        if (!setInfo && /트리플/i.test(inner)) {
            setInfo = { volume: null, count: 3, type: 'bracket_triple' };
            log(`   ✅ 세트 감지 (대괄호 내 트리플): 3개`);
            stats.setDetected++;
        }
    }

    // STEP 1.5: 대괄호 먼저 제거
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
    cleaned = cleaned.replace(/\[[^\]]*$/g, '');
    
    // STEP 2: 세트 감지 - 같은 용량 반복 패턴 (괄호 안)
    const sameVolumeMatch = cleaned.match(/\((\d+)(ml|mL|ML|g|G)\s*\+\s*(\d+)(ml|mL|ML|g|G)\)/i);
    if (sameVolumeMatch) {
        const vol1 = parseInt(sameVolumeMatch[1]);
        const unit1 = sameVolumeMatch[2].toLowerCase();
        const vol2 = parseInt(sameVolumeMatch[3]);
        const unit2 = sameVolumeMatch[4].toLowerCase();
        
        if (vol1 === vol2 && unit1 === unit2) {
            setInfo = { volume: `${vol1}${unit1}`, count: 2, type: 'same_volume' };
            log(`   ✅ 세트 감지 (같은 용량): ${vol1}${unit1} × 2`);
            cleaned = cleaned.replace(sameVolumeMatch[0], '');
            stats.setDetected++;
        } else {
            const mainVolume = Math.max(vol1, vol2);
            const mainUnit = vol1 > vol2 ? unit1 : unit2;
            log(`   ⚠️  다른 용량 감지 (증정품): ${vol1}${unit1} + ${vol2}${unit2} → ${mainVolume}${mainUnit} 유지`);
            cleaned = cleaned.replace(sameVolumeMatch[0], `${mainVolume}${mainUnit}`);
            stats.promotionalRemoved++;
        }
    }
    
    // STEP 2.5: 괄호 없는 용량+용량 패턴
    if (!setInfo) {
        const volumePlusVolumeMatch = cleaned.match(/(\d+)(ml|mL|ML|g|G)\s*\+\s*(\d+)(ml|mL|ML|g|G)/i);
        if (volumePlusVolumeMatch) {
            const vol1 = parseInt(volumePlusVolumeMatch[1]);
            const unit1 = volumePlusVolumeMatch[2].toLowerCase();
            const vol2 = parseInt(volumePlusVolumeMatch[3]);
            const unit2 = volumePlusVolumeMatch[4].toLowerCase();
            
            if (vol1 === vol2 && unit1 === unit2) {
                setInfo = { volume: `${vol1}${unit1}`, count: 2, type: 'same_volume_no_paren' };
                log(`   ✅ 세트 감지 (괄호 없는 같은 용량): ${vol1}${unit1} × 2`);
                cleaned = cleaned.replace(volumePlusVolumeMatch[0], '');
                stats.setDetected++;
            } else {
                const mainVolume = Math.max(vol1, vol2);
                const mainUnit = vol1 > vol2 ? unit1 : unit2;
                log(`   ⚠️  다른 용량 감지 (증정품): ${vol1}${unit1} + ${vol2}${unit2} → ${mainVolume}${mainUnit} 유지`);
                cleaned = cleaned.replace(volumePlusVolumeMatch[0], `${mainVolume}${mainUnit}`);
                stats.promotionalRemoved++;
            }
        }
    }
    
    // STEP 3: 세트 감지 - 50+50g 패턴
    const volumePlusMatch = cleaned.match(/(\d+)\s*\+\s*(\d+)\s*(ml|mL|ML|g|G)/i);
    if (volumePlusMatch && !setInfo) {
        const vol1 = parseInt(volumePlusMatch[1]);
        const vol2 = parseInt(volumePlusMatch[2]);
        const unit = volumePlusMatch[3].toLowerCase();
        
        if (vol1 === vol2) {
            setInfo = { volume: `${vol1}${unit}`, count: 2, type: 'volume_plus' };
            log(`   ✅ 세트 감지 (용량+용량): ${vol1}${unit} × 2`);
            cleaned = cleaned.replace(volumePlusMatch[0], `${vol1}${unit}`);
            stats.setDetected++;
        } else {
            const mainVolume = Math.max(vol1, vol2);
            log(`   ⚠️  다른 용량 감지: ${vol1}${unit} + ${vol2}${unit} → ${mainVolume}${unit} 유지`);
            cleaned = cleaned.replace(volumePlusMatch[0], `${mainVolume}${unit}`);
            stats.promotionalRemoved++;
        }
    }
    
    // STEP 4: 프로모션 키워드로 세트 감지
    const promoSetPatterns = [
        { pattern: /\[?\s*1\s*\+\s*1\s*\]?/gi, count: 2, name: '1+1' },
        { pattern: /\[?\s*2\s*\+\s*1\s*\]?/gi, count: 3, name: '2+1' },
        { pattern: /\[?\s*3\s*\+\s*1\s*\]?/gi, count: 4, name: '3+1' },
        { pattern: /더블기획/gi, count: 2, name: '더블기획' },
        { pattern: /더블\s*세트/gi, count: 2, name: '더블세트' },
        { pattern: /트리플기획/gi, count: 3, name: '트리플기획' },
        { pattern: /트리플\s*세트/gi, count: 3, name: '트리플세트' },
    ];
    
    for (const { pattern, count, name } of promoSetPatterns) {
        if (pattern.test(cleaned)) {
            if (!setInfo) {
                setInfo = { volume: null, count: count, type: 'promo_keyword' };
                log(`   ✅ 세트 감지 (프로모션 키워드): ${name} → ${count}개`);
                stats.setDetected++;
            } else if (setInfo.count < count) {
                log(`   ⚠️  세트 수량 업데이트: ${setInfo.count} → ${count}개`);
                setInfo.count = count;
            }
            cleaned = cleaned.replace(pattern, ' ');
        }
    }
    
    // 더블 (단독) 처리
    if (!setInfo && /더블/gi.test(cleaned)) {
        setInfo = { volume: null, count: 2, type: 'promo_double' };
        log(`   ✅ 세트 감지 (더블): 2개`);
        cleaned = cleaned.replace(/더블/gi, ' ');
        stats.setDetected++;
    }
    
    // +1 패턴 처리
    const plusOneMatch = cleaned.match(/\+\s*1\s*(?!개|입|매|ml|mL|g|G)/i);
    if (plusOneMatch && !cleaned.match(/\+\s*1\s*(파우치|미니|샘플|증정|크림|세럼|토너|로션|에센스)/i)) {
        if (!setInfo) {
            setInfo = { volume: null, count: 2, type: 'plus_one' };
            log(`   ✅ 세트 감지 (+1): 같은 제품 2개`);
            stats.setDetected++;
        }
        cleaned = cleaned.replace(/\+\s*1\s*(?!개|입|매|ml|mL|g|G)/gi, ' ');
    }
    
    // STEP 5-7: 괄호 제거
    cleaned = cleaned.replace(/^\s*\[[^\]]*\]\s*/g, '');
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
    // ✅ v2.11: 단독 용량 정보 (50ml), (200g) 등은 보존
    cleaned = cleaned.replace(/\(([^)]*)\)/g, (match, inner) => {
        if (/^\s*\d+\s*(ml|mL|ML|g|G)\s*$/.test(inner)) {
            return inner.trim();
        }
        return '';
    });
    cleaned = cleaned.replace(/【[^】]*】/g, '');
    cleaned = cleaned.replace(/〔[^〕]*〕/g, '');
    cleaned = cleaned.replace(/〈[^〉]*〉/g, '');
    cleaned = cleaned.replace(/《[^》]*》/g, '');
    cleaned = cleaned.replace(/\{[^}]*\}/g, '');
    
    // STEP 8: 프로모션/마케팅 키워드 제거
    const removeKeywords = [
        '기획증정', '기획 증정', '증정기획', '증정 기획',
        '기획세트', '기획 세트',
        '한정기획', '한정 기획', '단독기획', '단독 기획',
        '추가증정', '추가 증정',
        '선물세트', '선물 세트',
        '한정판', '한정 판매', '한정수량',
        '기획', '증정', '한정', '단독', '추가',
        '어워즈', '올영픽', '올영세일', '올영드', '올영추천', '올영딜',
        '특가', '세일', 'SALE', 'Sale', '행사', '이벤트', 'EVENT',
        '스페셜', 'Special', 'SPECIAL', '리미티드', 'Limited', 'LIMITED',
        '에디션', 'Edition', 'EDITION', '홀리데이', 'Holiday', 'HOLIDAY',
        '베스트', 'Best', 'BEST', '인기', '추천', '핫딜', 'HOT',
        'NEW', 'New', '신상', '신제품', '런칭', '출시기념',
        '리뉴얼', 'Renewal', 'RENEWAL',
        '듀오', '싱글', 'Duo', 'Single',
    ];
    
    for (const keyword of removeKeywords) {
        try {
            const regex = new RegExp(`(^|\\s)${keyword}(\\s|$)`, 'gi');
            cleaned = cleaned.replace(regex, ' ');
        } catch (e) {
            cleaned = cleaned.replace(new RegExp(keyword, 'gi'), '');
        }
    }
    
    // STEP 8.5: "외 N종" 패턴 제거
    cleaned = cleaned.replace(/외\s*\d+\s*종/gi, '');

    // STEP 8.6: 범용 프로모션 키워드 패턴 제거
    cleaned = cleaned.replace(/\s*(리필\s*기획|기획\s*세트|스페셜\s*에디션|한정판|콜라보\s*에디션)\s*/gi, ' ');

    // STEP 9: 공백 정리
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    // STEP 10: 세트 정보 추가
    if (setInfo) {
        const existingCountMatch = cleaned.match(/(\d+)\s*(개|입|매|pcs)/i);
        
        if (!existingCountMatch) {
            if (setInfo.volume) {
                cleaned = `${cleaned} ${setInfo.volume} ${setInfo.count}개`;
            } else {
                cleaned = `${cleaned} ${setInfo.count}개`;
            }
            log(`   ✅ 세트 정보 추가: ${setInfo.volume ? setInfo.volume + ' ' : ''}${setInfo.count}개`);
        }
    }
    
    // STEP 11: 최종 정리
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^[\/\-\s\+]+|[\/\-\s\+]+$/g, '');
    
    log(`   📝 클리닝 완료: "${cleaned}"`);
    
    return cleaned;
}

// ==================== 타이틀에서 용량 추출 ====================
function extractVolumeFromTitle(title) {
    if (!title) return null;
    
    const volumes = [];
    const volumePattern = /(\d+)\s*(ml|mL|ML|g|G)/gi;
    let match;
    
    while ((match = volumePattern.exec(title)) !== null) {
        volumes.push(match[1] + match[2].toLowerCase());
    }
    
    const countMatch = title.match(/(\d+)\s*(개|입|매)/);
    
    if (countMatch && volumes.length > 0) {
        const count = parseInt(countMatch[1]);
        const baseVolume = volumes[0];
        
        if (count > 1) {
            return `${baseVolume} × ${count}`;
        }
    }
    
    if (volumes.length > 1) {
        return volumes.join(' + ');
    }
    
    if (volumes.length === 1) {
        return volumes[0];
    }
    
    return null;
}

// ==================== 상세설명 포맷 함수 ====================
function formatDescriptionForShopify(infoTable, cleanedTitle) {
    const sections = [];
    
    const titleVolume = extractVolumeFromTitle(cleanedTitle);
    
    if (titleVolume) {
        sections.push(`**Volume:** ${titleVolume}`);
    } else if (infoTable.volume) {
        sections.push(`**Volume:** ${infoTable.volume}`);
    }
    
    if (infoTable.skinType && infoTable.skinType.length > 2) {
        sections.push(`**Skin Type:** ${infoTable.skinType}`);
    }
    
    if (infoTable.expiry && infoTable.expiry.length > 5) {
        sections.push(`**Shelf Life:** ${infoTable.expiry}`);
    }
    
    if (infoTable.usage && infoTable.usage.length > 10) {
        sections.push(`**How to Use:**\n${infoTable.usage}`);
    }
    
    if (infoTable.ingredients && infoTable.ingredients.length > 30) {
        sections.push(`**Ingredients:**\n${infoTable.ingredients}`);
    }
    
    return sections.join('\n\n');
}

// ==================== OpenAI 번역 함수 ====================
async function translateToEnglish(koreanText) {
    if (!openai || !koreanText) {
        return null;
    }
    
    try {
        log(`   🌐 번역 중: "${koreanText.substring(0, 50)}..."`);
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `당신은 한국 화장품 제품명을 영어로 번역하는 전문가입니다.

[번역 규칙]
1. 제품의 핵심 정보만 번역하세요: 브랜드명 + 제품 라인명 + 용량 + 세트 개수
2. 다음은 반드시 제거하고 번역하지 마세요:
   - 프로모션/기획명 (예: 리필기획, 더블기획, 올영특가, 단독기획)
   - 콜라보/캐릭터명 (예: 잠만보, 망그러진곰, 카카오프렌즈, 산리오)
   - 이벤트/한정 문구 (예: 한정판, 스페셜에디션, 기획세트)
   - 증정품 설명 (예: +미니어처 증정, 파우치 포함)
   - 시즌/날짜 문구 (예: 2026 봄, 설날 에디션)
3. 한국 화장품 브랜드명은 공식 영문명으로 정확히 번역하세요:
   - 파넬 → Parnell (Panel 아님)
   - 아누아 → Anua
   - 코스알엑스 → COSRX
   - 웰라쥬 → Wellage
   - 달바 → d'Alba
   - 토리든 → Torriden
   - 넘버즈인 → numbuzin
   - 라운드랩 → Round Lab
   - 메디힐 → Mediheal
   - 이니스프리 → innisfree
   - 미샤 → MISSHA
   - 에뛰드 → ETUDE
   - 닥터지 → Dr.G
   - 클리오 → CLIO
   - 롬앤 → rom&nd
   - 성분에디터 → Ongreedients
   - 조선미녀 → Beauty of Joseon
   - 스킨푸드 → SKINFOOD
   - 마녀공장 → Ma:nyo
   - 구달 → Goodal
   - 아이소이 → isoi
   - 에스트라 → Aestura
   - 바이오더마 → Bioderma
   - 아벤느 → Avène
   - 라로슈포제 → La Roche-Posay
   - 비오템 → Biotherm
   (위 목록에 없는 브랜드는 공식 영문 표기를 찾아 사용하세요)
4. 세트 정보는 정확히 유지하세요:
   - "2개" → "2 pcs" 또는 "Set of 2"
   - "1+1" → "2 pcs" (프로모션이 아닌 실제 세트인 경우만)
5. 용량 정보는 정확히 유지하세요: ml, mL, g, mg 등

[예시]
입력: "파넬 시카마누92세럼 30ml 리필기획 잠만보"
출력: "Parnell Cica Manu 92 Serum 30ml"

입력: "웰라쥬 리얼 히알루로닉 블루 100 앰플 75ml 2개기획 망그러진곰"
출력: "Wellage Real Hyaluronic Blue 100 Ampoule 75ml 2 pcs"

입력: "코스알엑스 더 6 펩타이드 스킨 부스터 세럼 150ml 1+1 올영단독"
출력: "COSRX The 6 Peptide Skin Booster Serum 150ml 2 pcs"

입력: "아누아 PRDN 히알루론산 캡슐100 세럼 30mL"
출력: "Anua PRDN Hyaluronic Acid Capsule 100 Serum 30mL"

Output ONLY the translated text, no explanations.`
                },
                {
                    role: 'user',
                    content: koreanText
                }
            ],
            max_tokens: 200,
            temperature: 0.3
        });
        
        const translatedText = response.choices[0].message.content.trim();
        log(`   ✅ 번역 완료: "${translatedText}"`);
        
        return translatedText;
        
    } catch (error) {
        log(`   ❌ 번역 실패: ${error.message}`);
        return null;
    }
}

async function translateDescriptionToEnglish(koreanDescription) {
    if (!openai || !koreanDescription) {
        return null;
    }
    
    try {
        log(`   🌐 설명 번역 중...`);
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional translator for Korean beauty product descriptions.
Translate the Korean product description to natural English for a Shopify store.
Keep the markdown format (**bold** headers like **Volume:**, **Skin Type:**, etc.).
For ingredients, translate to their common English cosmetic names.
Keep brand names accurate.
Output ONLY the translated text, no explanations.`
                },
                {
                    role: 'user',
                    content: koreanDescription.substring(0, 1500)
                }
            ],
            max_tokens: 800,
            temperature: 0.3
        });
        
        const translatedText = response.choices[0].message.content.trim();
        log(`   ✅ 설명 번역 완료 (${translatedText.length}자)`);
        
        return translatedText;
        
    } catch (error) {
        log(`   ❌ 설명 번역 실패: ${error.message}`);
        return null;
    }
}

// ==================== NocoDB: 제품 가져오기 ====================
async function getOliveyoungProducts(limit = 100, offset = 0) {
    try {
        log(`📥 NocoDB에서 제품 가져오는 중 (offset: ${offset}, limit: ${limit})...`);
        
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    offset: offset,
                    limit: limit,
                    where: '(title_kr,is,null)'
                }
            }
        );

        const products = response.data.list;
        log(`✅ ${products.length}개 제품 가져옴`);
        
        let needsTitle = 0, needsPrice = 0, needsDescription = 0, needsImages = 0;
        for (const p of products) {
            const missing = checkMissingFields(p);
            if (missing.needsTitleKr) needsTitle++;
            if (missing.needsPriceOriginal) needsPrice++;
            if (missing.needsDescription) needsDescription++;
            if (missing.needsImages) needsImages++;
        }
        
        log(`📊 빈 필드 현황:`);
        log(`   - title_kr 필요: ${needsTitle}개`);
        log(`   - price_original 필요: ${needsPrice}개`);
        log(`   - description 필요: ${needsDescription}개`);
        log(`   - product_images 필요: ${needsImages}개`);
        log('');
        
        return products;

    } catch (error) {
        log('❌ 제품 가져오기 실패:', error.response?.data || error.message);
        return [];
    }
}

// ==================== 이미지 다운로드 ====================
async function downloadImage(url, retryCount = 0) {
    const MAX_RETRIES = 2;
    
    try {
        if (!url || !url.startsWith('http')) {
            log(`   ⚠️  잘못된 URL: ${url}`);
            return null;
        }
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.oliveyoung.co.kr/',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'image',
                'sec-fetch-mode': 'no-cors',
                'sec-fetch-site': 'same-site'
            },
            validateStatus: function (status) {
                return status < 500;
            }
        });
        
        if (response.status === 404) {
            log(`   ⚠️  404 Not Found - 이미지 스킵`);
            stats.images404Skipped++;
            return null;
        }
        
        if (response.status !== 200) {
            log(`   ⚠️  HTTP ${response.status} - 이미지 스킵`);
            return null;
        }
        
        const buffer = Buffer.from(response.data);
        
        if (buffer.length < 1024) {
            log(`   ⚠️  이미지가 너무 작음 (${buffer.length} bytes) - 스킵`);
            return null;
        }
        
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        log(`   📥 다운로드 완료 (${sizeMB} MB)`);
        
        return buffer;

    } catch (error) {
        if (retryCount < MAX_RETRIES) {
            log(`   ⚠️  다운로드 실패, 재시도 중... (${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return downloadImage(url, retryCount + 1);
        }
        
        log(`   ❌ 다운로드 실패: ${error.message}`);
        stats.imagesDownloadFailed++;
        return null;
    }
}

// ==================== NocoDB: 파일 업로드 ====================
async function uploadToNocoDB(fileBuffer, filename) {
    try {
        log(`   📤 NocoDB 업로드: ${filename}`);
        
        const formData = new FormData();
        formData.append('file', fileBuffer, filename);

        const response = await axios.post(
            `${NOCODB_API_URL}/api/v2/storage/upload`,
            formData,
            {
                headers: {
                    'xc-token': NOCODB_TOKEN,
                    ...formData.getHeaders()
                },
                timeout: 60000
            }
        );

        log(`   ✅ 업로드 성공`);
        
        const uploadData = Array.isArray(response.data) ? response.data[0] : response.data;
        return uploadData;

    } catch (error) {
        log(`   ❌ 업로드 실패:`, error.response?.data || error.message);
        return null;
    }
}

// ==================== NocoDB: 제품 업데이트 ====================
async function updateProduct(recordId, updateData) {
    try {
        log(`📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        
        const fields = Object.keys(updateData).filter(k => k !== 'Id');
        log(`📋 업데이트 필드: ${fields.join(', ')}`);
        
        if (updateData.product_images) {
            log(`🗑️  기존 product_images 삭제 중...`);
            await axios.patch(
                `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
                [{ Id: recordId, product_images: null }],
                { 
                    headers: { 
                        'xc-token': NOCODB_TOKEN,
                        'Content-Type': 'application/json'
                    } 
                }
            );
        }
        
        const scrapedAt = new Date().toISOString();
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [{ 
                Id: recordId, 
                ...updateData,
                scraped_at: scrapedAt
            }],
            { 
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        log(`✅ 제품 레코드 업데이트 완료! (시간: ${scrapedAt})`);
        return true;

    } catch (error) {
        log('❌ 업데이트 실패:', error.response?.data || error.message);
        return false;
    }
}

// ==================== 이미지 처리 ====================
async function processProductImages(product, imageUrls) {
    try {
        if (imageUrls.length === 0) {
            log('❌ 이미지를 찾을 수 없습니다.');
            return [];
        }
        
        log(`📊 추출된 메인 갤러리 이미지: ${imageUrls.length}개`);
        imageUrls.slice(0, 7).forEach((url, i) => {
            log(`   ${i + 1}. ${url}`);
        });
        
        const maxImages = Math.min(imageUrls.length, 7);
        log(`📥 ${maxImages}개 이미지 다운로드 & 업로드 중...`);
        
        const uploadedFiles = [];
        
        for (let i = 0; i < maxImages; i++) {
            const url = imageUrls[i];
            log(`${i + 1}/${maxImages}: ${url}`);
            
            const buffer = await downloadImage(url);
            if (!buffer) {
                continue;
            }
            
            const filename = `gallery-${product.Id}-${i + 1}-${Date.now()}.jpg`;
            const uploadResult = await uploadToNocoDB(buffer, filename);
            
            if (uploadResult) {
                uploadedFiles.push(uploadResult);
            }
            
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        const attachments = uploadedFiles.map((file, index) => {
            let fullUrl = file.url;
            if (!fullUrl && file.path) {
                fullUrl = `${NOCODB_API_URL}/${file.path}`;
            }
            if (!fullUrl && file.signedPath) {
                fullUrl = `${NOCODB_API_URL}/${file.signedPath}`;
            }
            
            return {
                url: fullUrl || '',
                title: file.title || file.name || `gallery-image-${index + 1}.jpg`,
                mimetype: file.mimetype || file.type || 'image/jpeg',
                size: file.size || 0
            };
        });
        
        return attachments;
        
    } catch (error) {
        log(`❌ 이미지 처리 중 오류:`, error.message);
        return [];
    }
}

// ==================== ✅ v2.9.2: 배치 단위 크롤링 함수 ====================
async function processBatch(productsToProcess) {
    const totalProducts = productsToProcess.length;
    
    // 배치별 카운터 초기화
    processedCount = 0;
    successCount = 0;
    skippedCount = 0;
    failedCount = 0;
    
    const crawler = new PlaywrightCrawler({
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--single-process',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--metrics-recording-only',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                    '--js-flags=--max-old-space-size=512'
                ]
            }
        },
        
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
            retireBrowserAfterPageCount: 5,
        },
        
        requestHandler: async ({ page, request }) => {
            const product = request.userData.product;
            const index = request.userData.index;
            const missingFields = request.userData.missingFields;
            
            log('');
            log('='.repeat(70));
            log(`📦 [${index + 1}/${totalProducts}] 제품 ID: ${product.Id}`);
            log(`🔗 URL: ${request.url.substring(0, 80)}...`);
            log(`📋 필요한 필드: ${[
                missingFields.needsTitleKr ? 'title_kr' : null,
                missingFields.needsPriceOriginal ? 'price' : null,
                missingFields.needsDescription ? 'description' : null,
                missingFields.needsImages ? 'images' : null
            ].filter(Boolean).join(', ')}`);
            log('='.repeat(70));
            
            if ((index + 1) % MEMORY_CHECK_INTERVAL === 0) {
                logMemoryUsage(`[${index + 1}/${totalProducts}]`);
            }
            
            try {
                log(`📄 페이지 로딩 중...`);
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                
                // JavaScript 렌더링 대기
                await page.waitForTimeout(3000);
                
                // 제품명 요소가 나타날 때까지 추가 대기
                try {
                    await page.waitForSelector('p.prd_name, .prd_name, [class*="goods_name"], [class*="title_name_unity"]', { 
                        timeout: 5000 
                    });
                    log(`   ✅ 제품명 요소 감지됨`);
                } catch (e) {
                    log(`   ⚠️  제품명 요소 대기 시간 초과 (계속 진행)`);
                }
                
                const updateData = {};
                let hasUpdates = false;
                
                if (missingFields.needsTitleKr || missingFields.needsPriceOriginal || missingFields.needsDescription || missingFields.needsImages) {
                    log(`📊 웹페이지에서 정보 추출 중...`);
                    
                    // 상품정보 제공고시 클릭해서 펼치기
                    try {
                        const infoToggle = await page.$('text=상품정보 제공고시');
                        if (infoToggle) {
                            await infoToggle.click();
                            log(`   ✅ 상품정보 제공고시 섹션 펼침`);
                            await page.waitForTimeout(1000);
                        }
                    } catch (e) {
                        log(`   ⚠️  상품정보 제공고시 클릭 실패 (무시하고 계속)`);
                    }
                    
                    const productData = await page.evaluate(() => {
                        const result = {
                            rawTitle: '',
                            priceOriginal: 0,
                            priceDiscount: 0,
                            infoTable: {
                                volume: '',
                                skinType: '',
                                expiry: '',
                                usage: '',
                                ingredients: ''
                            },
                            imageUrls: [],
                            expectedImageCount: 0,
                            debugInfo: ''
                        };
                        
                        // ===== 타이틀 추출 =====
                        const titleSelectors = [
                            '.goodsDetailInfo_title_name_unity',
                            '[class*="title_name_unity"]',
                            '[data-ref="prod-product-title"]',
                            'p.prd_name',
                            '.prd_name',
                            '.goods-name',
                            '.prd-info p.prd_name',
                            '.prd_detail_box .prd_name',
                            '.goods_detail_box .prd_name',
                            '[class*="goodsName"]',
                            '[class*="goods_name"]',
                            '.pdtInfoWrap .prd_name',
                            '.prd_info_area .prd_name',
                            '#Contents .prd_name',
                            '[class*="title_name"]',
                            '[class*="product_name"]',
                            '[class*="productName"]',
                            'h1',
                            'h2.prd_name',
                        ];
                        
                        for (const selector of titleSelectors) {
                            try {
                                const el = document.querySelector(selector);
                                if (el) {
                                    const text = el.textContent.trim();
                                    if (text.length > 5 && text.length < 150) {
                                        result.rawTitle = text;
                                        break;
                                    }
                                }
                            } catch (e) {}
                        }
                        
                        // 타이틀 fallback: meta 태그
                        if (!result.rawTitle) {
                            const ogTitle = document.querySelector('meta[property="og:title"]');
                            if (ogTitle && ogTitle.content) {
                                result.rawTitle = ogTitle.content.trim();
                            }
                        }
                        
                        // 타이틀 fallback: JSON-LD
                        if (!result.rawTitle) {
                            const jsonLd = document.querySelector('script[type="application/ld+json"]');
                            if (jsonLd) {
                                try {
                                    const data = JSON.parse(jsonLd.textContent);
                                    if (data.name) {
                                        result.rawTitle = data.name;
                                    } else if (data['@graph']) {
                                        const productItem = data['@graph'].find(item => item['@type'] === 'Product');
                                        if (productItem && productItem.name) {
                                            result.rawTitle = productItem.name;
                                        }
                                    }
                                } catch (e) {}
                            }
                        }
                        
                        // ===== 가격 추출 =====
                        const priceSelectors = [
                            '[class*="GoodsDetailInfo_price"]',
                            '[class*="price-area"]',
                            '[class*="price_area"]',
                            '[class*="prd_price"]',
                            '[class*="goods_price"]',
                            '.price-box',
                            '.price_box',
                            '[class*="price"]'
                        ];
                        
                        for (const selector of priceSelectors) {
                            try {
                                const priceEl = document.querySelector(selector);
                                if (priceEl) {
                                    const priceText = priceEl.textContent;
                                    const prices = priceText.match(/[\d,]+원/g);
                                    
                                    if (prices && prices.length >= 2) {
                                        result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                        result.priceDiscount = parseInt(prices[1].replace(/[^0-9]/g, ''));
                                        break;
                                    } else if (prices && prices.length === 1) {
                                        result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                        result.priceDiscount = result.priceOriginal;
                                        break;
                                    }
                                }
                            } catch (e) {}
                        }
                        
                        if (result.priceOriginal && result.priceDiscount && 
                            result.priceOriginal < result.priceDiscount) {
                            const temp = result.priceOriginal;
                            result.priceOriginal = result.priceDiscount;
                            result.priceDiscount = temp;
                        }
                        
                        // ===== 메인 갤러리 이미지 추출 =====
                        const seenUrls = new Set();
                        const mainGalleryImages = [];
                        
                        const paginationEl = document.querySelector('.swiper-pagination, [class*="pagination"]');
                        if (paginationEl) {
                            const paginationText = paginationEl.textContent.trim();
                            const countMatch = paginationText.match(/\d+\s*\/\s*(\d+)/);
                            if (countMatch) {
                                result.expectedImageCount = parseInt(countMatch[1]);
                            }
                        }
                        
                        const mainGallerySelectors = [
                            '.vis-swiper .swiper-slide img',
                            '.vis-swiper [data-swiper-slide-index] img',
                            '[class*="vis-swiper"] .swiper-slide img',
                            '[class*="GoodsDetail_Carousel"] img',
                            '[class*="Carousel_content"] img',
                            '.swiper-slide[data-swiper-slide-index] img',
                            '.prd-img .swiper-slide img',
                            '.goods-img .swiper-slide img',
                        ];
                        
                        let foundMethod = '';
                        
                        for (const selector of mainGallerySelectors) {
                            try {
                                const imgs = document.querySelectorAll(selector);
                                
                                if (imgs.length > 0) {
                                    foundMethod = selector;
                                    
                                    imgs.forEach(img => {
                                        let src = img.getAttribute('data-src') ||
                                                  img.getAttribute('data-origin') ||
                                                  img.getAttribute('data-lazy') ||
                                                  img.getAttribute('data-original') ||
                                                  img.src ||
                                                  img.getAttribute('src');
                                        
                                        if (!src) return;
                                        
                                        if (src.startsWith('//')) {
                                            src = 'https:' + src;
                                        }
                                        
                                        if (!src.includes('oliveyoung.co.kr')) return;
                                        
                                        if (src.includes('/gdasEditor/')) return;
                                        if (src.includes('/display/')) return;
                                        if (src.includes('/icon/')) return;
                                        if (src.includes('/badge/')) return;
                                        if (src.includes('/banner/')) return;
                                        if (src.includes('/event/')) return;
                                        if (src.includes('/logo/')) return;
                                        if (src.includes('/btn/')) return;
                                        if (src.includes('/common/')) return;
                                        if (src.includes('/review/')) return;
                                        if (src.includes('/point/')) return;
                                        if (src.includes('/coupon/')) return;
                                        
                                        if (seenUrls.has(src)) return;
                                        
                                        seenUrls.add(src);
                                        mainGalleryImages.push(src);
                                    });
                                    
                                    if (mainGalleryImages.length > 0) {
                                        break;
                                    }
                                }
                            } catch (e) {}
                        }
                        
                        if (mainGalleryImages.length === 0) {
                            foundMethod = 'fallback: large images';
                            
                            const allSlides = document.querySelectorAll('[data-swiper-slide-index]');
                            
                            allSlides.forEach(slide => {
                                const img = slide.querySelector('img');
                                if (!img) return;
                                
                                let src = img.getAttribute('data-src') ||
                                          img.getAttribute('data-origin') ||
                                          img.src;
                                
                                if (!src || !src.includes('oliveyoung.co.kr')) return;
                                
                                if (src.startsWith('//')) {
                                    src = 'https:' + src;
                                }
                                
                                if (src.includes('/gdasEditor/')) return;
                                if (src.includes('/display/')) return;
                                if (src.includes('/banner/')) return;
                                
                                if (seenUrls.has(src)) return;
                                seenUrls.add(src);
                                mainGalleryImages.push(src);
                            });
                        }
                        
                        if (mainGalleryImages.length === 0) {
                            foundMethod = 'fallback: all large oliveyoung images';
                            
                            const allImages = document.querySelectorAll('img');
                            allImages.forEach(img => {
                                let src = img.getAttribute('data-src') ||
                                          img.getAttribute('data-origin') ||
                                          img.src;
                                
                                if (!src || !src.includes('oliveyoung.co.kr')) return;
                                if (seenUrls.has(src)) return;
                                
                                if (src.startsWith('//')) {
                                    src = 'https:' + src;
                                }
                                
                                if (src.includes('/gdasEditor/')) return;
                                if (src.includes('/display/')) return;
                                if (src.includes('/icon/')) return;
                                if (src.includes('/badge/')) return;
                                if (src.includes('/banner/')) return;
                                if (src.includes('/review/')) return;
                                
                                const width = img.naturalWidth || img.width;
                                const height = img.naturalHeight || img.height;
                                
                                if (width >= 400 && height >= 400) {
                                    seenUrls.add(src);
                                    mainGalleryImages.push(src);
                                }
                            });
                        }
                        
                        result.debugInfo = `Method: ${foundMethod}, Found: ${mainGalleryImages.length}`;
                        result.imageUrls = mainGalleryImages.slice(0, 10);
                        
                        // ===== 상품정보 제공고시 추출 =====
                        const EXCLUDE_KEYWORDS = [
                            '제조업자', '수입업자', '판매업자', '책임판매업자',
                            '맞춤형화장품판매업자', '품질보증', '소비자상담', 
                            '전화', '고객센터', '080', '1588', '1577',
                            '협력사', '본 상품 정보', '공정거래', 
                            '㈜', '주식회사', '제조국', '원산지',
                            'A/S', '교환', '반품', '대한민국', 
                            '분쟁해결', '보상해드립니다', '위원회 고시'
                        ];
                        
                        const allRows = document.querySelectorAll('tr');
                        
                        allRows.forEach(row => {
                            const cells = row.querySelectorAll('th, td');
                            if (cells.length < 2) return;
                            
                            const label = (cells[0].textContent || '').trim();
                            const value = (cells[1].textContent || '').trim();
                            
                            const fullText = label + value;
                            if (EXCLUDE_KEYWORDS.some(kw => fullText.includes(kw))) {
                                return;
                            }
                            
                            if ((label.includes('용량') || label.includes('중량') || label.includes('내용물')) && !result.infoTable.volume) {
                                const volumeMatch = value.match(/(\d+\s*[mMlLgG]+(?:\s*[×x+]\s*\d+\s*[mMlLgG]*)*(?:\s*\+\s*\d+\s*[mMlLgG]+)*)/);
                                if (volumeMatch) {
                                    result.infoTable.volume = volumeMatch[1].trim();
                                } else if (value.length < 50) {
                                    result.infoTable.volume = value;
                                }
                            }
                            
                            if ((label.includes('주요') || label.includes('사양') || label.includes('피부')) && !result.infoTable.skinType) {
                                if (value.length > 2 && value.length < 100) {
                                    result.infoTable.skinType = value;
                                }
                            }
                            
                            if ((label.includes('사용기한') || label.includes('개봉')) && !result.infoTable.expiry) {
                                if (value.length > 5 && value.length < 100) {
                                    result.infoTable.expiry = value;
                                }
                            }
                            
                            if (label.includes('사용방법') && !result.infoTable.usage) {
                                let usage = value
                                    .split(/화장품제조업자|제조업자|판매업자|㈜|주식회사/)[0]
                                    .trim();
                                
                                if (usage.length > 10 && usage.length < 500) {
                                    result.infoTable.usage = usage;
                                }
                            }
                            
                            if ((label.includes('모든 성분') || label.includes('전성분') || label.includes('화장품법')) && !result.infoTable.ingredients) {
                                let ingredients = value
                                    .split(/화장품제조업자|제조업자|기능성|품질/)[0]
                                    .replace(/\s+/g, ' ')
                                    .trim();
                                
                                if (ingredients.length > 30) {
                                    result.infoTable.ingredients = ingredients;
                                }
                            }
                        });
                        
                        // div 구조에서도 추출 시도
                        if (!result.infoTable.volume || !result.infoTable.usage) {
                            const allDivs = document.querySelectorAll('div[class*="info"], div[class*="spec"], dl');
                            
                            allDivs.forEach(div => {
                                const text = div.textContent || '';
                                
                                if (EXCLUDE_KEYWORDS.some(kw => text.includes(kw))) {
                                    return;
                                }
                                
                                if (!result.infoTable.volume && (text.includes('용량') || text.includes('내용물'))) {
                                    const match = text.match(/(\d+\s*[mMlLgG]+(?:\s*[×x+]\s*\d+)?)/);
                                    if (match) {
                                        result.infoTable.volume = match[1];
                                    }
                                }
                                
                                if (!result.infoTable.usage && text.includes('사용방법')) {
                                    const match = text.match(/사용방법\s*[:\s]*(.{20,300}?)(?=\.|화장품|제조|$)/);
                                    if (match) {
                                        result.infoTable.usage = match[1].trim();
                                    }
                                }
                            });
                        }
                        
                        return result;
                    });
                    
                    log(`📋 추출된 정보:`);
                    log(`   타이틀: ${productData.rawTitle ? productData.rawTitle.substring(0, 60) + '...' : '❌ 없음'}`);
                    log(`   정가: ${productData.priceOriginal ? '₩' + productData.priceOriginal.toLocaleString() : '❌ 없음'}`);
                    log(`   할인가: ${productData.priceDiscount ? '₩' + productData.priceDiscount.toLocaleString() : '❌ 없음'}`);
                    log(`   🖼️  메인 갤러리 이미지: ${productData.imageUrls.length}개 (예상: ${productData.expectedImageCount || '?'}개)`);
                    log(`   🔍 추출 방법: ${productData.debugInfo}`);
                    log(`   📦 상품정보 제공고시:`);
                    log(`      용량: ${productData.infoTable.volume || '❌ 없음'}`);
                    log(`      피부타입: ${productData.infoTable.skinType || '❌ 없음'}`);
                    log(`      사용기한: ${productData.infoTable.expiry || '❌ 없음'}`);
                    log(`      사용방법: ${productData.infoTable.usage ? productData.infoTable.usage.substring(0, 40) + '...' : '❌ 없음'}`);
                    log(`      성분: ${productData.infoTable.ingredients ? productData.infoTable.ingredients.substring(0, 40) + '...' : '❌ 없음'}`);
                    
                    // 1. 타이틀 처리
                    let cleanedTitle = '';
                    if (missingFields.needsTitleKr && productData.rawTitle) {
                        cleanedTitle = cleanProductTitle(productData.rawTitle);
                        updateData.title_kr = cleanedTitle;
                        hasUpdates = true;
                        stats.titleKrFilled++;
                        
                        log(`📝 타이틀 클리닝 (v2.9):`);
                        log(`   원본: "${productData.rawTitle.substring(0, 60)}"`);
                        log(`   정제: "${cleanedTitle}"`);
                        
                        // v2.9: 용량 제한 체크
                        if (MAX_VOLUME_LIMIT > 0) {
                            let totalVolume = calculateTotalVolume(cleanedTitle);
                            let volumeSource = '타이틀';
                            
                            if (totalVolume === 0 && productData.infoTable.volume) {
                                totalVolume = calculateTotalVolume(productData.infoTable.volume);
                                volumeSource = '상세설명';
                                
                                if (totalVolume > 0 && totalVolume <= MAX_VOLUME_LIMIT) {
                                    const volumeMatch = productData.infoTable.volume.match(/(\d+)\s*(ml|mL|ML|g|G)/i);
                                    if (volumeMatch) {
                                        const volumeStr = `${volumeMatch[1]}${volumeMatch[2].toLowerCase()}`;
                                        cleanedTitle = `${cleanedTitle} ${volumeStr}`;
                                        updateData.title_kr = cleanedTitle;
                                        log(`   ✅ 타이틀에 용량 추가: "${cleanedTitle}"`);
                                    }
                                }
                            }
                            
                            log(`   📦 용량 계산 (${volumeSource}): ${totalVolume}ml (제한: ${MAX_VOLUME_LIMIT}ml)`);
                            
                            if (totalVolume > MAX_VOLUME_LIMIT) {
                                log(`   ⚠️  용량 초과! ${totalVolume}ml > ${MAX_VOLUME_LIMIT}ml → 스킵`);
                                stats.volumeExceededSkipped++;
                                skippedCount++;
                                processedCount++;
                                return;
                            }
                        }

                        if (missingFields.needsTitleEn) {
                            const englishTitle = await translateToEnglish(cleanedTitle);
                            if (englishTitle) {
                                updateData.title_en = englishTitle;
                                stats.titleEnFilled++;
                            }
                        }
                    } else if (!missingFields.needsTitleKr) {
                        log(`📝 타이틀: 이미 있음 → 스킵`);
                        stats.titleKrSkipped++;
                        cleanedTitle = product.title_kr || '';
                        
                        if (MAX_VOLUME_LIMIT > 0 && cleanedTitle) {
                            const totalVolume = calculateTotalVolume(cleanedTitle);
                            log(`   📦 용량 계산 (기존 타이틀): ${totalVolume}ml (제한: ${MAX_VOLUME_LIMIT}ml)`);
                            
                            if (totalVolume > MAX_VOLUME_LIMIT) {
                                log(`   ⚠️  용량 초과! ${totalVolume}ml > ${MAX_VOLUME_LIMIT}ml → 스킵`);
                                stats.volumeExceededSkipped++;
                                skippedCount++;
                                processedCount++;
                                return;
                            }
                        }
                        
                        if (missingFields.needsTitleEn && product.title_kr) {
                            const englishTitle = await translateToEnglish(product.title_kr);
                            if (englishTitle) {
                                updateData.title_en = englishTitle;
                                hasUpdates = true;
                                stats.titleEnFilled++;
                            }
                        }
                    }
                    
                    // 2. 가격 처리
                    if (missingFields.needsPriceOriginal && productData.priceOriginal) {
                        updateData.price_original = productData.priceOriginal;
                        hasUpdates = true;
                        stats.priceFilled++;
                        
                        if (productData.priceDiscount && productData.priceDiscount < productData.priceOriginal) {
                            updateData.price_discount = productData.priceDiscount;
                        } else {
                            updateData.price_discount = productData.priceOriginal;
                        }
                        
                        log(`💰 가격:`);
                        log(`   정가 (price_original): ₩${updateData.price_original.toLocaleString()}`);
                        log(`   할인가 (price_discount): ₩${updateData.price_discount.toLocaleString()}`);
                    } else if (!missingFields.needsPriceOriginal) {
                        log(`💰 가격: 이미 있음 → 스킵`);
                        stats.priceSkipped++;
                    }
                    
                    // 3. 설명 처리
                    if (missingFields.needsDescription) {
                        const titleToUse = cleanedTitle || product.title_kr || '';
                        const formattedDesc = formatDescriptionForShopify(productData.infoTable, titleToUse);
                        
                        if (formattedDesc && formattedDesc.length > 10) {
                            updateData.description = formattedDesc;
                            hasUpdates = true;
                            stats.descriptionFilled++;
                            
                            log(`📄 설명 (쇼핑몰 포맷):`);
                            formattedDesc.split('\n').slice(0, 5).forEach(line => {
                                if (line.trim()) log(`   ${line}`);
                            });
                            
                            if (missingFields.needsDescriptionEn) {
                                const englishDesc = await translateDescriptionToEnglish(formattedDesc);
                                if (englishDesc) {
                                    updateData.description_en = englishDesc;
                                }
                            }
                        } else {
                            log(`⚠️  상세설명 추출 실패`);
                        }
                    } else if (!missingFields.needsDescription) {
                        log(`📄 설명: 이미 있음 → 스킵`);
                        stats.descriptionSkipped++;
                    }
                    
                    // 4. 이미지 처리
                    if (missingFields.needsImages && productData.imageUrls.length > 0) {
                        log(`🖼️  메인 갤러리 이미지 처리 중...`);
                        
                        const attachments = await processProductImages(product, productData.imageUrls);
                        
                        if (attachments.length > 0) {
                            updateData.product_images = attachments;
                            hasUpdates = true;
                            stats.imagesFilled++;
                            log(`✅ ${attachments.length}개 메인 갤러리 이미지 처리 완료`);
                        }
                    } else if (!missingFields.needsImages) {
                        log(`🖼️  이미지: 이미 있음 → 스킵`);
                        stats.imagesSkipped++;
                    }
                }
                
                // NocoDB 업데이트
                if (hasUpdates) {
                    const success = await updateProduct(product.Id, updateData);
                    if (success) {
                        successCount++;
                    } else {
                        failedCount++;
                    }
                } else {
                    log(`ℹ️  업데이트할 내용 없음`);
                    skippedCount++;
                }
                
                processedCount++;
                
            } catch (pageError) {
                log('⚠️  페이지 처리 오류:', pageError.message);
                failedCount++;
                processedCount++;
            }
            
            // 메모리 정리
            if ((index + 1) % BATCH_SIZE === 0) {
                log(`\n🧹 메모리 정리 중... (${index + 1}개 처리 완료)`);
                await forceGarbageCollection();
                logMemoryUsage('정리 후');
            }
        },
        
        maxRequestsPerCrawl: 1000,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 180,
        maxRequestRetries: 2,
        navigationTimeoutSecs: 60,
    });
    
    const requests = productsToProcess.map((product, index) => ({
        url: product.product_url,
        userData: {
            product: product,
            index: index,
            missingFields: checkMissingFields(product)
        }
    }));
    
    log(`🌐 Crawler 시작 - ${productsToProcess.length}개 제품 처리`);
    log('');
    
    try {
        await crawler.run(requests);
    } finally {
        await crawler.teardown();
    }
    
    return { processedCount, successCount, failedCount, skippedCount };
}

// ==================== ✅ v2.9.2: 배치 반복 메인 함수 ====================
async function main() {
    log('🚀 Phase 1: 메인 갤러리 이미지 + 타이틀/가격/설명 추출 (v2.9.2)');
    log('='.repeat(70));
    log('');
    
    logMemoryUsage('시작');
    
    // ✅ v2.9.2: PRODUCT_LIMIT을 배치 크기로 사용 (기본 20)
    const BATCH_LIMIT = parseInt(process.env.PRODUCT_LIMIT) || 20;
    
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let batchNumber = 0;
    
    try {
        // ✅ v2.9.2: 미처리 제품이 없을 때까지 배치 반복
        while (true) {
            batchNumber++;
            log(`\n${'═'.repeat(70)}`);
            log(`🔄 배치 ${batchNumber} 시작 (${BATCH_LIMIT}개씩 처리)`);
            log(`${'═'.repeat(70)}`);
            
            // 미처리 제품 가져오기 (where: title_kr is null)
            const products = await getOliveyoungProducts(BATCH_LIMIT, 0);
            
            if (products.length === 0) {
                log('✅ 더 이상 미처리 제품이 없습니다. 종료합니다.');
                break;
            }
            
            // product_url 필터링
            const productsToProcess = products.filter(p => {
                if (!p.product_url || p.product_url.trim() === '') {
                    stats.noUrlSkipped++;
                    log(`⚠️  제품 ID ${p.Id}: product_url이 없음 → 스킵`);
                    return false;
                }
                const missing = checkMissingFields(p);
                return missing.needsPageVisit;
            });
            
            log(`📋 이 배치에서 처리할 제품: ${productsToProcess.length}/${products.length}개`);
            if (stats.noUrlSkipped > 0) {
                log(`⚠️  product_url 없음으로 스킵 (누적): ${stats.noUrlSkipped}개`);
            }
            
            if (productsToProcess.length === 0) {
                log('✅ 이 배치에서 처리할 제품이 없습니다. 종료합니다.');
                break;
            }
            
            // ✅ 배치 단위로 크롤러 생성/실행/종료 (메모리 관리)
            const batchResult = await processBatch(productsToProcess);
            
            totalProcessed += batchResult.processedCount;
            totalSuccess += batchResult.successCount;
            totalFailed += batchResult.failedCount;
            totalSkipped += batchResult.skippedCount;
            
            log(`\n📊 배치 ${batchNumber} 결과: 성공 ${batchResult.successCount}, 실패 ${batchResult.failedCount}, 스킵 ${batchResult.skippedCount}`);
            
            // 메모리 정리
            await forceGarbageCollection();
            logMemoryUsage(`배치 ${batchNumber} 완료 후`);
            
            // 배치 간 대기 (서버 부하 방지)
            log('⏳ 다음 배치 전 5초 대기...\n');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        // ==================== 최종 결과 ====================
        log('');
        log('='.repeat(70));
        log('🎉 Phase 1 완료!');
        log('='.repeat(70));
        log(`📦 총 배치 수: ${batchNumber}`);
        log(`✅ 성공: ${totalSuccess}개 제품`);
        log(`⭕ 스킵: ${totalSkipped}개 제품`);
        log(`❌ 실패: ${totalFailed}개 제품`);
        log(`📊 총 처리: ${totalProcessed}개 제품`);
        
        log(`\n📊 필드별 통계:`);
        log(`   - title_kr: ${stats.titleKrFilled}개 채움, ${stats.titleKrSkipped}개 스킵`);
        log(`   - title_en: ${stats.titleEnFilled}개 채움, ${stats.titleEnSkipped}개 스킵`);
        log(`   - price: ${stats.priceFilled}개 채움, ${stats.priceSkipped}개 스킵`);
        log(`   - description: ${stats.descriptionFilled}개 채움, ${stats.descriptionSkipped}개 스킵`);
        log(`   - images: ${stats.imagesFilled}개 채움, ${stats.imagesSkipped}개 스킵`);
        log(`   - images 404: ${stats.images404Skipped}개 스킵`);
        log(`   - images 다운로드 실패: ${stats.imagesDownloadFailed}개`);
        log(`   - 세트 감지: ${stats.setDetected}개`);
        log(`   - 증정품 제거: ${stats.promotionalRemoved}개`);
        log(`   - 용량 초과 스킵: ${stats.volumeExceededSkipped}개`);
        log(`   - ⚠️  product_url 없음 스킵: ${stats.noUrlSkipped}개`);
        
        logMemoryUsage('최종');
        
        log(`📝 로그 파일: ${LOG_PATH}`);
        log(`💡 다음 단계: Phase 2 실행`);
        log(`   node phase2-ai-generate.js`);
        
    } catch (error) {
        log('❌ 치명적 오류:', error.message);
        log(error.stack);
    } finally {
        logStream.end();
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    log('');
    log('⚠️  SIGINT 수신 - 안전하게 종료 중...');
    logStream.end();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('');
    log('⚠️  SIGTERM 수신 - 안전하게 종료 중...');
    logStream.end();
    process.exit(0);
});

main();