import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PlaywrightCrawler } from 'crawlee';
import { trackGeminiCall, geminiCounter } from './gemini-api-counter.js';

dotenv.config();

const execAsync = promisify(exec);

// ==================== 로그 시스템 설정 ====================
const SYDNEY_TIMEZONE = 'Australia/Sydney';
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_RETENTION_DAYS = 5;

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

const deletedLogs = cleanupOldLogs();

// ✅ 통합 로그 경로 (파이프라인 실행 시 설정됨)
const UNIFIED_LOG_PATH = process.env.UNIFIED_LOG_PATH || null;

const LOG_FILENAME = `phase4_${getSydneyTimeForFile()}.log`;
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
    const separator = '═══ PHASE 4: 이미지 선별 시작 ═══';
    try {
        fs.appendFileSync(UNIFIED_LOG_PATH, `\n${separator}\n`);
    } catch (e) {
        // 무시
    }
}

// ==================== 환경 변수 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL;
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const PYTHON_PATH = '/root/copychu-scraper/rembg-env/bin/python';
const REMBG_PATH = '/root/copychu-scraper/rembg-env/bin/rembg';

const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);

// ==================== 설정 ====================
const TARGET_SIZE = 1200;
const PRODUCT_RATIO = 0.75;
const MIN_SCORE_FOR_GALLERY = 50;  // ✅ v9: 70 → 50으로 완화

log('🚀 Phase 4: 최고 이미지 선별 + 네이버 보충 (v11 개선 버전)');
log('='.repeat(70));
log(`⚙️  설정:`);
log(`   - Shopify Table: ${SHOPIFY_TABLE_ID}`);
log(`   - 최종 크기: ${TARGET_SIZE}x${TARGET_SIZE}px`);
log(`   - 제품 비율: ${PRODUCT_RATIO * 100}%`);
log(`   - Gallery 최소 점수: ${MIN_SCORE_FOR_GALLERY}점`);
log(`\n✨ v11 핵심 변경:`);
log(`   ✅ v10 유지: 용량 50%+ 차이 -30점, 품질 12점 미만 -20점`);
log(`   ✅ 여러 제품 감지: -20점 → -40점 (개별 제품에 다른 제품 포함 방지)\n`);

// ==================== 유틸리티 ====================
const cleanupFiles = (...files) => {
    files.forEach(file => {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });
};

// ==================== Oliveyoung 제품 정보 가져오기 ====================
async function getOliveyoungProduct(productId) {
    try {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { where: `(Id,eq,${productId})` }
            }
        );
        
        if (response.data.list.length > 0) {
            return response.data.list[0];
        }
        return null;
    } catch (error) {
        log(`   ⚠️  Oliveyoung 제품 정보 조회 실패:`, error.message);
        return null;
    }
}

// ==================== NocoDB에서 제품 가져오기 ====================
async function getProductsFromNocoDB() {
    const response = await axios.get(
        `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
        {
            headers: { 'xc-token': NOCODB_API_TOKEN },
            params: {
                limit: parseInt(process.env.PRODUCT_LIMIT) || 1000,
                where: '(validated_images,notnull)'
            }
        }
    );
    
    return response.data.list;
}

// ==================== 이미지 다운로드 ====================
async function downloadImage(imageUrl, outputPath) {
    const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.naver.com'
        }
    });
    fs.writeFileSync(outputPath, Buffer.from(response.data));
}

// ==================== 이미지 해상도 확인 ====================
function getImageResolution(imagePath) {
    try {
        const pythonScript = `
from PIL import Image
img = Image.open('${imagePath}')
print(f'{img.width},{img.height}')
`;
        
        const scriptPath = `/tmp/get_resolution_${Date.now()}.py`;
        fs.writeFileSync(scriptPath, pythonScript);
        
        const result = execSync(`${PYTHON_PATH} ${scriptPath}`, { encoding: 'utf-8' }).trim();
        cleanupFiles(scriptPath);
        
        const [width, height] = result.split(',').map(Number);
        
        if (!width || !height || isNaN(width) || isNaN(height)) {
            return null;
        }
        
        return { width, height, minDimension: Math.min(width, height) };
        
    } catch (error) {
        log('      ❌ 해상도 확인 오류:', error.message);
        return null;
    }
}

// ==================== 제품명에서 정보 추출 ====================
function extractProductInfo(productTitle) {
    const info = {
        brandName: null,
        productLineName: null,
        volume: null,
        volumeNumber: null,
        volumeUnit: null,
        setCount: null,
        isSetProduct: false
    };
    
    const brandMatch = productTitle.match(/^([A-Za-z]+)/);
    if (brandMatch) {
        info.brandName = brandMatch[1].toLowerCase();
    }
    
    const productLineMatch = productTitle.match(/^[A-Za-z]+\s+(.+?)(?:\s+\d+\s*(?:ml|mL|g|G|pcs|개)|\s+Set|\s+세트|$)/i);
    if (productLineMatch) {
        info.productLineName = productLineMatch[1].trim().toLowerCase();
    }
    
    const volumeMatch = productTitle.match(/(\d+)\s*(ml|mL|ML|g|G)/i);
    if (volumeMatch) {
        info.volumeNumber = parseInt(volumeMatch[1]);
        info.volumeUnit = volumeMatch[2].toLowerCase();
        info.volume = `${info.volumeNumber}${info.volumeUnit}`;
    }
    
    const setMatch = productTitle.match(/set of (\d+)|(\d+)개|(\d+)\s*pcs?/i);
    if (setMatch) {
        info.setCount = parseInt(setMatch[1] || setMatch[2] || setMatch[3]);
        info.isSetProduct = info.setCount > 1;
    }
    
    if (!info.isSetProduct) {
        info.isSetProduct = /세트|set|기획|듀오|duo|트윈|twin|패키지/i.test(productTitle);
    }
    
    return info;
}

// ==================== 1. 해상도 점수 (0-30점) ====================
function calculateResolutionScore(resolution) {
    if (!resolution) return 0;
    
    const { width, height } = resolution;
    const avgResolution = (width + height) / 2;
    
    if (avgResolution >= 1200) return 30;
    if (avgResolution >= 1000) return 25;
    if (avgResolution >= 800) return 20;
    if (avgResolution >= 600) return 15;
    return 10;
}

// ==================== v9: 여러 제품 감지 (탈락 → 감점) ====================
async function detectMultipleProducts(imagePath, productTitle, productInfo) {
    try {
        if (productInfo.isSetProduct) {
            log(`      🎁 세트 제품 → 여러 제품 검사 생략`);
            return { hasMultiple: false, count: 1, penalty: 0 };
        }
        
        log(`      🔍 여러 제품 감지 중... (개별 제품)`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 제품 이미지를 분석해주세요.

제품명: "${productTitle}"

**질문: 이 이미지에 동일한 제품이 몇 개 보이나요?**

판단 기준:
1. 실물 제품(화장품 병, 튜브, 용기 등)이 몇 개 있나요?
2. 그림자나 반사는 제품 개수에 포함하지 마세요
3. 포장박스는 제품 개수에 포함하지 마세요

다음 형식으로만 답변하세요:
COUNT: [숫자]
REASON: [한 줄 설명]`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('detectMultipleProducts');
        
        const response = result.response.text().trim();
        
        const countMatch = response.match(/COUNT:\s*(\d+)/i);
        const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);
        
        const detectedCount = countMatch ? parseInt(countMatch[1]) : 1;
        const reason = reasonMatch ? reasonMatch[1].trim() : '응답 파싱 실패';
        
        // ✅ v11: 여러 제품 감지 시 더 강한 감점!
        if (detectedCount >= 2) {
            log(`      ⚠️  여러 제품 감지 (${detectedCount}개) - ${reason}`);
            log(`      📉 감점: -40점 (개별 제품에 다른 제품 포함!)`);
            return { hasMultiple: true, count: detectedCount, reason, penalty: -40 };
        } else {
            log(`      ✅ 단일 제품 확인 (${detectedCount}개) - ${reason}`);
            return { hasMultiple: false, count: detectedCount, reason, penalty: 0 };
        }
        
    } catch (error) {
        log('      ❌ 여러 제품 감지 실패:', error.message);
        return { hasMultiple: false, count: 1, penalty: 0 };
    }
}

// ==================== 포장박스 감지 (탈락 → 감점) ====================
async function detectPackagingBox(imagePath, productTitle) {
    try {
        log(`      📦 포장박스 감지 중...`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 제품 이미지를 분석해주세요.

제품명: "${productTitle}"

**질문: 이 이미지에 포장박스(패키지 상자)가 있나요?**

판단 기준:
1. 제품 본체 외에 **종이 상자**, **패키지 박스**가 보이나요?
2. 제품이 박스 안에 들어있거나, 박스 옆에 놓여있나요?

⚠️ 주의: 
- 제품 자체의 플라스틱 용기/튜브/병은 포장박스가 아닙니다
- 종이로 된 외부 상자만 포장박스입니다

다음 형식으로만 답변하세요:
PACKAGING: [YES/NO]
REASON: [한 줄 설명]`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('detectPackagingBox');
        
        const response = result.response.text().trim();
        
        const packagingMatch = response.match(/PACKAGING:\s*(YES|NO)/i);
        const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);
        
        const hasPackaging = packagingMatch ? packagingMatch[1].toUpperCase() === 'YES' : false;
        const reason = reasonMatch ? reasonMatch[1].trim() : '응답 파싱 실패';
        
        // ✅ v9: 탈락 대신 감점!
        if (hasPackaging) {
            log(`      ⚠️  포장박스 감지됨 - ${reason}`);
            log(`      📉 감점: -15점 (탈락 아님!)`);
            return { hasPackaging: true, reason, penalty: -15 };
        } else {
            log(`      ✅ 포장박스 없음 - ${reason}`);
            return { hasPackaging: false, reason, penalty: 0 };
        }
        
    } catch (error) {
        log('      ❌ 포장박스 감지 실패:', error.message);
        return { hasPackaging: false, penalty: 0 };
    }
}

// ==================== 2. 완성도 점수 (0-25점) - v9: 탈락 없음! ====================
async function calculateCompletenessScore(imagePath, productTitle, productInfo) {
    try {
        log(`      🔍 제품 완성도 검증 시작...`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const expectedCount = productInfo.setCount || 1;
        
        const prompt = `이 제품 이미지를 분석하여 제품이 완전한지 확인해주세요.

제품명: "${productTitle}"
예상 제품 개수: ${expectedCount}개

다음을 검사해주세요:
1. 제품이 잘려있나요? (캡, 바디, 하단)
2. 제품 전체가 이미지 안에 있나요?

다음 형식으로만 답변하세요:
COMPLETE: [YES/NO]
REASON: [이유를 한 줄로]`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('calculateCompletenessScore');
        
        const response = result.response.text().trim();
        
        const completeMatch = response.match(/COMPLETE:\s*(YES|NO)/i);
        const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);
        
        const isComplete = completeMatch ? completeMatch[1].toUpperCase() === 'YES' : false;
        const reason = reasonMatch ? reasonMatch[1].trim() : '응답 파싱 실패';
        
        // ✅ v9: 불완전해도 탈락 안함! 낮은 점수만
        if (isComplete) {
            log(`      ✅ 완성도: 25/25점 - ${reason}`);
            return 25;
        } else {
            log(`      ⚠️  완성도: 10/25점 - ${reason}`);
            log(`      📉 불완전하지만 계속 평가! (탈락 아님)`);
            return 10;  // ✅ v9: 0점 → 10점
        }
        
    } catch (error) {
        log('      ❌ 완성도 검증 실패:', error.message);
        return 15;  // 에러 시 중립 점수
    }
}

// ==================== 3. 타이틀 매칭 점수 (0-30점) - v9: 탈락 없음! ====================
async function calculateTitleMatchScore(imagePath, productTitle, productInfo, originalImageUrl = null) {
    try {
        log(`      🔍 타이틀 매칭 확인 시작...`);
        
        let base64;
        let imageSource = '크롭 이미지';
        
        if (originalImageUrl) {
            try {
                log(`      📥 원본 이미지로 확인 중...`);
                const response = await axios.get(originalImageUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.oliveyoung.co.kr'
                    }
                });
                base64 = Buffer.from(response.data).toString('base64');
                imageSource = '원본 이미지';
                log(`      ✅ 원본 이미지 로드 완료`);
            } catch (err) {
                log(`      ⚠️  원본 이미지 로드 실패, 크롭 이미지 사용`);
                const imageBuffer = fs.readFileSync(imagePath);
                base64 = imageBuffer.toString('base64');
            }
        } else {
            const imageBuffer = fs.readFileSync(imagePath);
            base64 = imageBuffer.toString('base64');
        }
        
        log(`      🖼️  검사 대상: ${imageSource}`);
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 제품 이미지를 분석해주세요.

**타겟 제품:**
- 브랜드: "${productInfo.brandName || 'N/A'}"
- 제품 라인: "${productInfo.productLineName || 'N/A'}"
- 용량: "${productInfo.volume || 'N/A'}"

**이미지에서 확인해주세요:**
1. 브랜드명
2. 제품명/라인명
3. 용량 (ml, g 등)

다음 형식으로만 답변:
BRAND: [읽은 브랜드명 또는 UNKNOWN]
PRODUCT_LINE: [읽은 제품라인명 또는 UNKNOWN]
VOLUME: [읽은 용량 또는 UNKNOWN]`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('calculateTitleMatchScore');
        
        const response = result.response.text().trim();
        log(`      📄 Gemini 응답:\n${response.split('\n').map(l => '         ' + l).join('\n')}`);
        
        const brandMatch = response.match(/BRAND:\s*([^\n]+)/i);
        const productLineMatch = response.match(/PRODUCT_LINE:\s*([^\n]+)/i);
        const volumeMatch = response.match(/VOLUME:\s*([^\n]+)/i);
        
        const detectedBrand = brandMatch ? brandMatch[1].trim().toLowerCase() : 'unknown';
        const detectedProductLine = productLineMatch ? productLineMatch[1].trim().toLowerCase() : 'unknown';
        const detectedVolume = volumeMatch ? volumeMatch[1].trim().toLowerCase() : 'unknown';
        
        let score = 0;
        const targetBrand = (productInfo.brandName || '').toLowerCase();
        const targetLine = (productInfo.productLineName || '').toLowerCase();
        
        // ✅ v9: 브랜드 확인 (불일치해도 탈락 안함!)
        if (detectedBrand !== 'unknown' && targetBrand) {
            if (detectedBrand.includes(targetBrand) || targetBrand.includes(detectedBrand)) {
                score += 10;
                log(`      ✅ 브랜드 일치: ${detectedBrand} (+10점)`);
            } else {
                score += 5;  // ✅ v9: 불일치해도 5점
                log(`      ⚠️  브랜드 불일치: ${detectedBrand} ≠ ${targetBrand} (+5점)`);
            }
        } else {
            score += 5;
            log(`      ⚠️  브랜드 미확인 (+5점)`);
        }
        
        // ✅ v9: 제품 라인 확인 (불일치해도 탈락 안함!)
        if (detectedProductLine !== 'unknown' && targetLine) {
            const targetWords = targetLine.split(' ').slice(0, 2).join(' ');
            const detectedWords = detectedProductLine.split(' ').slice(0, 2).join(' ');
            
            if (detectedProductLine.includes(targetWords) || targetLine.includes(detectedWords) || 
                detectedWords.includes(targetWords) || targetWords.includes(detectedWords)) {
                score += 10;
                log(`      ✅ 제품 라인 일치 (+10점)`);
            } else {
                score += 5;  // ✅ v9: 불일치해도 5점
                log(`      ⚠️  제품 라인 불일치 (+5점)`);
            }
        } else {
            score += 5;
            log(`      ⚠️  제품 라인 미확인 (+5점)`);
        }
        
        // ✅ v10: 용량 확인 (큰 차이는 강력 감점!)
        let volumePenalty = 0;
        if (detectedVolume !== 'unknown' && productInfo.volume) {
            const detectedNum = parseInt(detectedVolume.match(/\d+/)?.[0] || '0');
            const expectedNum = productInfo.volumeNumber;
            
            if (expectedNum && detectedNum > 0) {
                const diffPercent = Math.abs(detectedNum - expectedNum) / expectedNum * 100;
                
                if (detectedNum === expectedNum) {
                    score += 10;
                    log(`      ✅ 용량 일치: ${detectedVolume} (+10점)`);
                } else if (diffPercent <= 15) {
                    // 15% 이내 차이 (예: 220ml vs 200ml)
                    score += 7;
                    log(`      ⚠️  용량 근사: ${detectedVolume} ≈ ${productInfo.volume} (+7점)`);
                } else if (diffPercent <= 30) {
                    // 30% 이내 차이
                    score += 3;
                    log(`      ⚠️  용량 차이: ${detectedVolume} ≠ ${productInfo.volume} (+3점)`);
                } else {
                    // ✅ v10: 50% 이상 차이는 완전히 다른 제품! 강력 감점!
                    volumePenalty = -30;
                    log(`      ❌ 용량 크게 불일치: ${detectedVolume} ≠ ${productInfo.volume}`);
                    log(`      📉 다른 제품 감점: -30점`);
                }
            }
        } else {
            score += 5;
            log(`      ⚠️  용량 미확인 (+5점)`);
        }
        
        score += volumePenalty;
        
        log(`      📊 타이틀 매칭: ${score}/30점`);
        
        return { score, isWrongProduct: false };  // ✅ v9: 항상 isWrongProduct: false
        
    } catch (error) {
        log('      ❌ 타이틀 매칭 확인 실패:', error.message);
        return { score: 15, isWrongProduct: false };
    }
}

// ==================== 4. 세트 구성 점수 (0-20점) ====================
async function calculateSetCompositionScore(imagePath, productTitle, productInfo) {
    try {
        log(`      🔍 세트 구성 분석 시작...`);
        
        if (!productInfo.setCount || productInfo.setCount === 1) {
            log(`      ✅ 단일 제품 → 자동 20점`);
            return 20;
        }
        
        log(`      🎁 세트 제품: ${productInfo.setCount}개 예상`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 이미지를 분석하여 세트 제품 구성을 평가해주세요.

제품명: "${productTitle}"
예상 세트 개수: ${productInfo.setCount}개

다음 형식으로 답변하세요:
COUNT: [숫자]
SUITABLE: [EXCELLENT/GOOD/FAIR/POOR]`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('calculateSetCompositionScore');
        
        const response = result.response.text().trim();
        
        const countMatch = response.match(/COUNT:\s*(\d+)/i);
        const suitableMatch = response.match(/SUITABLE:\s*(EXCELLENT|GOOD|FAIR|POOR)/i);
        
        const detectedCount = countMatch ? parseInt(countMatch[1]) : 0;
        const suitable = suitableMatch ? suitableMatch[1].toUpperCase() : 'FAIR';
        
        let score = 0;
        
        if (detectedCount === productInfo.setCount) {
            score += 10;
        } else if (Math.abs(detectedCount - productInfo.setCount) === 1) {
            score += 5;
        }
        
        if (suitable === 'EXCELLENT') score += 10;
        else if (suitable === 'GOOD') score += 7;
        else if (suitable === 'FAIR') score += 4;
        else score += 2;
        
        score = Math.max(0, Math.min(20, score));
        log(`      📊 세트 구성: ${score}/20점`);
        
        return score;
        
    } catch (error) {
        log('      ❌ 세트 구성 분석 실패:', error.message);
        return 10;
    }
}

// ==================== 5. Gemini 품질 평가 (0-20점) ====================
async function calculateQualityScore(imagePath, productTitle) {
    try {
        log(`      🤖 이미지 품질 평가 중...`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 제품 이미지의 품질을 평가해주세요.

평가 기준:
1. 선명도
2. 중앙 배치
3. 배경 품질
4. 쇼핑몰 사용 적합성

0-20점 사이로 점수를 매겨주세요.
숫자만 답변하세요.`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('calculateQualityScore');
        
        const response = result.response.text().trim();
        const score = parseInt(response);
        
        if (isNaN(score) || score < 0 || score > 20) {
            log(`      ⚠️  유효하지 않은 점수: ${response}, 기본값 12점 사용`);
            return 12;
        }
        
        log(`      📊 이미지 품질: ${score}/20점`);
        return score;
        
    } catch (error) {
        log('      ⚠️  품질 평가 실패:', error.message);
        return 12;
    }
}

// ==================== v9: 이미지 점수 계산 (탈락 없음!) ====================
async function scoreImage(imageData, imagePath, productTitle, productInfo, index) {
    log(`\n   이미지 ${index + 1} 평가:`);
    log(`   ${'─'.repeat(66)}`);
    
    const scores = {
        resolution: 0,
        completeness: 0,
        titleMatch: 0,
        setComposition: 0,
        quality: 0,
        penalties: 0  // ✅ v9: 감점 항목 추가
    };
    
    const resolution = getImageResolution(imagePath);
    scores.resolution = calculateResolutionScore(resolution);
    log(`      📐 해상도: ${scores.resolution}/30점 (${resolution?.width}x${resolution?.height})`);
    
    // ✅ v9: 여러 제품 감지 → 탈락 대신 감점!
    const multipleResult = await detectMultipleProducts(imagePath, productTitle, productInfo);
    scores.penalties += multipleResult.penalty;
    
    // ✅ v9: 포장박스 감지 → 탈락 대신 감점!
    const packagingResult = await detectPackagingBox(imagePath, productTitle);
    scores.penalties += packagingResult.penalty;
    
    // ✅ v9: 완성도 점수 (항상 평가, 탈락 없음!)
    scores.completeness = await calculateCompletenessScore(imagePath, productTitle, productInfo);
    
    // ✅ v9: 타이틀 매칭 (항상 평가, 탈락 없음!)
    const titleMatchResult = await calculateTitleMatchScore(imagePath, productTitle, productInfo, imageData.originalUrl || null);
    scores.titleMatch = titleMatchResult.score;
    
    // 세트 구성 점수
    scores.setComposition = await calculateSetCompositionScore(imagePath, productTitle, productInfo);
    
    // 품질 점수
    scores.quality = await calculateQualityScore(imagePath, productTitle);
    
    // ✅ v10: 품질이 너무 낮으면 감점!
    if (scores.quality < 12) {
        scores.penalties += -20;
        log(`      📉 품질 저하 감점: -20점 (품질 ${scores.quality}점 < 12점)`);
    }
    
    // ✅ v9: 총점 계산 (감점 포함)
    const totalScore = Math.max(0, 
        scores.resolution + scores.completeness + scores.titleMatch + 
        scores.setComposition + scores.quality + scores.penalties
    );
    
    log(`      📉 감점: ${scores.penalties}점`);
    log(`      🎯 총점: ${totalScore}/125점`);
    
    return {
        imageData,
        imagePath,
        resolution,
        scores,
        totalScore,
        // ✅ v9: 모든 플래그 false (탈락 없음!)
        isIncomplete: false,
        isWrongProduct: false,
        hasPackaging: false,
        hasMultipleProducts: false
    };
}

// ==================== 크기 정규화 ====================
function normalizeImage(imagePath) {
    log('      📐 크기 정규화 중...');
    const outputPath = imagePath.replace('.png', '_normalized.png');
    
    const pythonScript = `
from PIL import Image
import numpy as np

img = Image.open('${imagePath}')

if img.mode == 'RGBA':
    alpha = np.array(img.split()[3])
    rows = np.any(alpha > 10, axis=1)
    cols = np.any(alpha > 10, axis=0)
    
    if np.any(rows) and np.any(cols):
        y_min, y_max = np.where(rows)[0][[0, -1]]
        x_min, x_max = np.where(cols)[0][[0, -1]]
        product = img.crop((x_min, y_min, x_max + 1, y_max + 1))
    else:
        product = img
else:
    img_array = np.array(img)
    non_white = np.any(img_array < 250, axis=2)
    rows = np.any(non_white, axis=1)
    cols = np.any(non_white, axis=0)
    
    if np.any(rows) and np.any(cols):
        y_min, y_max = np.where(rows)[0][[0, -1]]
        x_min, x_max = np.where(cols)[0][[0, -1]]
        product = img.crop((x_min, y_min, x_max + 1, y_max + 1))
    else:
        product = img

target_size = ${TARGET_SIZE}
product_ratio = ${PRODUCT_RATIO}
target_product_size = int(target_size * product_ratio)

product_width, product_height = product.size
scale = min(target_product_size / product_width, target_product_size / product_height)

new_width = int(product_width * scale)
new_height = int(product_height * scale)

product_resized = product.resize((new_width, new_height), Image.Resampling.LANCZOS)

canvas = Image.new('RGB', (target_size, target_size), (255, 255, 255))

x_offset = (target_size - new_width) // 2
y_offset = (target_size - new_height) // 2

if product_resized.mode == 'RGBA':
    canvas.paste(product_resized, (x_offset, y_offset), product_resized.split()[3])
else:
    canvas.paste(product_resized, (x_offset, y_offset))

canvas.save('${outputPath}', 'PNG', quality=95)
`;
    
    const scriptPath = `/tmp/normalize_${Date.now()}.py`;
    fs.writeFileSync(scriptPath, pythonScript);
    
    try {
        execSync(`${PYTHON_PATH} ${scriptPath}`);
        log(`      ✅ 정규화 완료: ${TARGET_SIZE}x${TARGET_SIZE}px`);
        cleanupFiles(scriptPath);
        return outputPath;
    } catch (error) {
        log('      ❌ 정규화 실패:', error.message);
        cleanupFiles(scriptPath);
        return null;
    }
}

// ==================== NocoDB 업로드 ====================
async function uploadToNocoDB(filePath, fileName) {
    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), fileName);
        
        const response = await axios.post(
            `${NOCODB_API_URL}/api/v2/storage/upload`,
            formData,
            {
                headers: {
                    'xc-token': NOCODB_API_TOKEN,
                    ...formData.getHeaders()
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );
        
        return response.data;
    } catch (error) {
        log('      ❌ 업로드 실패:', error.message);
        throw error;
    }
}

// ==================== 네이버 이미지 검색 ====================
async function searchNaverImages(titleKr, maxImages = 15) {
    log(`\n🔍 네이버 이미지 검색 시작: "${titleKr}"`);
    log(`   목표: 원본 이미지 ${maxImages}개 수집`);
    
    const imageUrls = [];
    
    const crawler = new PlaywrightCrawler({
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            }
        },
        
        requestHandler: async ({ page }) => {
            try {
                log(`   🔄 페이지 로딩 중...`);
                
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                log(`   ✅ DOM 로딩 완료`);
                
                log(`   ⏳ 이미지 렌더링 대기 중 (5초)...`);
                await page.waitForTimeout(5000);
                
                log(`   🔍 인네일 이미지 URL 추출 중...\n`);
                
                const extractedUrls = await page.evaluate((max) => {
                    const results = [];
                    
                    const thumbnails = document.querySelectorAll('img._fe_image_tab_content_thumbnail_image');
                    
                    thumbnails.forEach((img, index) => {
                        const thumbnailUrl = img.src;
                        
                        if (!thumbnailUrl || !thumbnailUrl.includes('search.pstatic.net/common')) {
                            return;
                        }
                        
                        try {
                            const url = new URL(thumbnailUrl);
                            const srcParam = url.searchParams.get('src');
                            
                            if (srcParam) {
                                const originalUrl = decodeURIComponent(srcParam);
                                
                                if (originalUrl.startsWith('http')) {
                                    results.push({
                                        index: index,
                                        original: originalUrl
                                    });
                                }
                            }
                        } catch (e) {}
                    });
                    
                    return results.slice(0, max);
                }, maxImages);
                
                log(`   ✅ 추출 완료: ${extractedUrls.length}개\n`);
                
                if (extractedUrls.length > 0) {
                    extractedUrls.forEach((item, i) => {
                        log(`      ${i + 1}. ${item.original.substring(0, 80)}...`);
                        imageUrls.push(item.original);
                    });
                }
                
            } catch (error) {
                log('   ❌ 페이지 처리 오류:', error.message);
            }
        },
        
        maxRequestsPerCrawl: 1,
        requestHandlerTimeoutSecs: 60
    });
    
    const searchUrl = `https://search.naver.com/search.naver?ssc=tab.image.all&where=image&sm=tab_jum&query=${encodeURIComponent(titleKr)}`;
    
    await crawler.run([searchUrl]);
    await crawler.teardown();

    log(`\n   ✅ 최종 수집: ${imageUrls.length}개 원본 이미지`);
    return imageUrls;
}

// ==================== 이미지 크기 확인 ====================
async function getImageDimensions(imagePath) {
    const pythonScript = `/tmp/get_dims_${Date.now()}.py`;
    const script = `import cv2
img = cv2.imread('${imagePath}')
if img is not None:
    h, w = img.shape[:2]
    print(f'{w},{h}')
`;
    
    fs.writeFileSync(pythonScript, script);
    
    try {
        const { stdout } = await execAsync(`${PYTHON_PATH} "${pythonScript}"`);
        cleanupFiles(pythonScript);
        
        const [width, height] = stdout.trim().split(',').map(Number);
        
        if (!width || !height) return null;
        
        return { width, height };
        
    } catch (error) {
        cleanupFiles(pythonScript);
        return null;
    }
}

// ==================== Gemini 크롭 좌표 요청 ====================
async function getCropCoordinates(imageUrl, productTitle, imageWidth, imageHeight) {
    try {
        log(`      🔍 크롭 좌표 요청 중...`);
        
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://www.naver.com'
            }
        });
        const base64 = Buffer.from(response.data).toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const isSetProduct = /set of \d+|세트|\d+개입|\d+개 세트|(\d+)\s*pcs?/i.test(productTitle);

        const prompt = `이 이미지에서 "${productTitle}" 제품의 본체만 찾아주세요.

이미지 크기: ${imageWidth}x${imageHeight} 픽셀
${isSetProduct ? '세트 제품: 모든 제품을 포함' : '단일 제품: 1개만 선택'}

제품 본체만 포함 (포장박스 제외)

JSON 형식으로만 답변:
{
  "found": true,
  "x": 픽셀_x좌표,
  "y": 픽셀_y좌표,
  "width": 픽셀_너비,
  "height": 픽셀_높이
}`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64, mimeType: 'image/jpeg' } }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('getCropCoordinates_Naver');

        const responseText = result.response.text();
        
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const coords = JSON.parse(jsonMatch[0]);
            if (coords.found) {
                log(`      📍 좌표: (${coords.x}, ${coords.y}) ${coords.width}x${coords.height}`);
            }
            return coords;
        }
        
        return null;
        
    } catch (error) {
        log('      ❌ 크롭 좌표 요청 실패:', error.message);
        return null;
    }
}

// ==================== 좌표 확장 ====================
function expandCoordinates(coords, imageWidth, imageHeight, expandRatio = 0.2) {
    const expandWidth = coords.width * expandRatio;
    const expandHeight = coords.height * expandRatio;
    
    let newX = Math.round(coords.x - expandWidth / 2);
    let newY = Math.round(coords.y - expandHeight / 2);
    let newWidth = Math.round(coords.width * (1 + expandRatio));
    let newHeight = Math.round(coords.height * (1 + expandRatio));
    
    newX = Math.max(0, newX);
    newY = Math.max(0, newY);
    newWidth = Math.min(newWidth, imageWidth - newX);
    newHeight = Math.min(newHeight, imageHeight - newY);
    
    return { x: newX, y: newY, width: newWidth, height: newHeight };
}

// ==================== 이미지 크롭 ====================
async function cropImage(inputPath, outputPath, x, y, width, height) {
    const pythonScript = `/tmp/crop_${Date.now()}.py`;
    const script = `import cv2
img = cv2.imread('${inputPath}')
if img is not None:
    h, w = img.shape[:2]
    x = max(0, min(${x}, w))
    y = max(0, min(${y}, h))
    width = min(${width}, w - x)
    height = min(${height}, h - y)
    cropped = img[y:y+height, x:x+width]
    cv2.imwrite('${outputPath}', cropped)
`;
    
    fs.writeFileSync(pythonScript, script);
    
    try {
        await execAsync(`${PYTHON_PATH} "${pythonScript}"`);
        cleanupFiles(pythonScript);
        
        if (fs.existsSync(outputPath)) {
            log(`      ✅ 크롭 완료`);
            return true;
        }
        return false;
        
    } catch (error) {
        cleanupFiles(pythonScript);
        return false;
    }
}

// ==================== 배경 제거 + 흰색 배경 ====================
async function removeBackgroundAndAddWhite(inputPath, outputPath) {
    log(`      🎨 배경 제거 + 흰색 배경 중...`);
    
    try {
        const tempTransparent = outputPath.replace('.png', '_temp.png');
        
        await execAsync(`${REMBG_PATH} i "${inputPath}" "${tempTransparent}"`);
        
        if (!fs.existsSync(tempTransparent)) {
            return false;
        }
        
        const pythonScript = `/tmp/add_white_${Date.now()}.py`;
        const pythonCode = `from PIL import Image
img = Image.open('${tempTransparent}').convert('RGBA')
white_bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
white_bg.paste(img, (0, 0), img)
white_bg.convert('RGB').save('${outputPath}', 'PNG')
`;
        
        fs.writeFileSync(pythonScript, pythonCode);
        await execAsync(`${PYTHON_PATH} "${pythonScript}"`);
        
        cleanupFiles(tempTransparent, pythonScript);
        
        if (fs.existsSync(outputPath)) {
            log(`      ✅ 완료!`);
            return true;
        }
        return false;
        
    } catch (error) {
        log('      ❌ rembg 실패:', error.message);
        return false;
    }
}

// ==================== 제품 처리 (핵심) ====================
async function processProduct(product, productIndex, totalProducts) {
    const { Id, validated_images } = product;
    
    log(`\n${'='.repeat(70)}`);
    log(`📦 제품 ${productIndex}/${totalProducts} - ID: ${Id}`);
    
    log(`\n🗑️  Step 0: 초기화`);
    
    try {
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            { Id: Id, main_image: null, gallery_images: null },
            { headers: { 'xc-token': NOCODB_API_TOKEN, 'Content-Type': 'application/json' } }
        );
        log(`   ✅ 초기화 완료!\n`);
    } catch (error) {
        log(`   ❌ 초기화 실패:`, error.message);
        return;
    }
    
    log(`🔍 Step 1: 제품 정보 조회`);
    
    const oliveyoungProduct = await getOliveyoungProduct(Id);
    
    let productTitle = 'Unknown Product';
    let titleKr = 'Unknown Product';
    if (oliveyoungProduct) {
        productTitle = oliveyoungProduct.title_en || oliveyoungProduct.title_kr || 'Unknown Product';
        titleKr = oliveyoungProduct.title_kr || 'Unknown Product';
        log(`✅ 제품명 (EN): ${productTitle}`);
        log(`✅ 제품명 (KR): ${titleKr}`);
    }
    
    const productInfo = extractProductInfo(productTitle);
    
    log(`📋 제품 정보:`);
    log(`   - 브랜드: ${productInfo.brandName || 'N/A'}`);
    log(`   - 제품 라인: ${productInfo.productLineName || 'N/A'}`);
    log(`   - 용량: ${productInfo.volume || 'N/A'}`);
    log(`   - 세트: ${productInfo.isSetProduct ? '✅' : '❌'}`);
    
    if (!validated_images || validated_images.length === 0) {
        log('⚠️  validated_images 없음');
        return;
    }
    
    log(`📸 검증된 이미지: ${validated_images.length}개\n`);
    
    log(`📊 Step 2: 이미지 평가 (v9 완화 버전)`);
    log(`${'─'.repeat(70)}`);
    
    const scoredImages = [];
    
    for (let i = 0; i < validated_images.length; i++) {
        const img = validated_images[i];
        
        let imageUrl = img.url;
        if (!imageUrl && img.path) {
            imageUrl = `${NOCODB_API_URL}/${img.path}`;
        }
        
        if (!imageUrl) continue;
        
        const tempPath = `/tmp/score-${Id}-${i}-${Date.now()}.png`;
        
        try {
            await downloadImage(imageUrl, tempPath);
            
            const scored = await scoreImage(img, tempPath, productTitle, productInfo, i);
            scoredImages.push(scored);
            
            if (i < validated_images.length - 1) {
                log(`\n      ⏳ 10초 대기...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
        } catch (error) {
            log(`\n   ❌ 이미지 ${i + 1} 평가 실패:`, error.message);
            cleanupFiles(tempPath);
        }
    }
    
    if (scoredImages.length === 0) {
        log('\n⚠️  평가된 이미지 없음');
        return;
    }
    
    // ✅ v9: 모든 이미지가 점수를 받으므로 필터링 없이 정렬만!
    scoredImages.sort((a, b) => b.totalScore - a.totalScore);
    
    log(`\n📊 평가 결과 (점수순):`);
    scoredImages.forEach((img, idx) => {
        log(`   ${idx + 1}위: ${img.totalScore}/125점 (감점: ${img.scores.penalties})`);
    });
    
    log(`\n✂️  Step 3: 상위 3개 선별`);
    
    const selectedForSave = scoredImages.slice(0, 3);  // ✅ v9: 상위 3개 선택
    
    log(`   선별됨: ${selectedForSave.length}개`);
    
    log(`\n📐 Step 4: 정규화 + 업로드`);
    
    const processedImages = [];
    
    for (let i = 0; i < selectedForSave.length; i++) {
        const selected = selectedForSave[i];
        
        log(`\n   ${i + 1}/${selectedForSave.length} 처리 중...`);
        
        if (!selected || !selected.imagePath || !fs.existsSync(selected.imagePath)) {
            log('      ❌ 유효하지 않은 이미지');
            continue;
        }
        
        const normalizedPath = normalizeImage(selected.imagePath);
        if (!normalizedPath || !fs.existsSync(normalizedPath)) {
            log('      ❌ 정규화 실패');
            cleanupFiles(selected.imagePath);
            continue;
        }
        
        try {
            log('      📤 NocoDB 업로드 중...');
            const fileName = `final-${Id}-${i + 1}-${Date.now()}.png`;
            const uploadResult = await uploadToNocoDB(normalizedPath, fileName);
            
            if (uploadResult && uploadResult.length > 0) {
                processedImages.push(uploadResult[0]);
                log('      ✅ 완료!');
            }
        } catch (uploadError) {
            log('      ❌ 업로드 오류:', uploadError.message);
        }
        
        cleanupFiles(selected.imagePath, normalizedPath);
    }
    
    if (processedImages.length === 0) {
        log('\n⚠️  처리된 이미지 없음');
        scoredImages.forEach(img => cleanupFiles(img.imagePath));
        return;
    }
    
    log(`\n💾 Step 5: DB 저장`);
    
    const mainImage = processedImages[0];
    const galleryImages = processedImages.slice(1);
    const madeAt = new Date().toISOString();
    
    try {
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                Id: Id,
                main_image: [mainImage],
                gallery_images: galleryImages.length > 0 ? galleryImages : null,
                made_at: madeAt
            },
            { headers: { 'xc-token': NOCODB_API_TOKEN, 'Content-Type': 'application/json' } }
        );
        
        log(`✅ 저장 완료!`);
        log(`   - main_image: 1개`);
        log(`   - gallery_images: ${galleryImages.length}개`);
    } catch (error) {
        log(`❌ 저장 실패:`, error.message);
        scoredImages.forEach(img => cleanupFiles(img.imagePath));
        return;
    }
    
    scoredImages.forEach(img => cleanupFiles(img.imagePath));
    
    // Step 6: DB 확인
    log(`\n🔍 Step 6: DB 확인`);
    
    let actualMainCount = 0;
    let actualGalleryCount = 0;
    
    try {
        const verifyResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            { headers: { 'xc-token': NOCODB_API_TOKEN }, params: { where: `(Id,eq,${Id})` } }
        );
        
        if (verifyResponse.data.list.length > 0) {
            const savedProduct = verifyResponse.data.list[0];
            actualMainCount = savedProduct.main_image?.length > 0 ? 1 : 0;
            actualGalleryCount = savedProduct.gallery_images?.length || 0;
            
            log(`   - Main: ${actualMainCount}개`);
            log(`   - Gallery: ${actualGalleryCount}개`);
        }
    } catch (error) {
        actualMainCount = 1;
        actualGalleryCount = galleryImages.length;
    }
    
    const totalCount = actualMainCount + actualGalleryCount;
    
    if (totalCount >= 3) {
        log(`\n✅ 충분함! (${totalCount}/3개)`);
        return;
    }
    
    log(`\n⚠️  부족함! (${totalCount}/3개) → 네이버 보충`);
    const needed = 3 - totalCount;
    
    // 네이버 보충 로직 (간소화)
    log(`\n🌐 Step 7: 네이버 검색`);
    
    const naverUrls = await searchNaverImages(titleKr, needed === 1 ? 10 : 15);
    
    if (naverUrls.length === 0) {
        log(`   ❌ 네이버 이미지 없음`);
        return;
    }
    
    const filteredUrls = naverUrls.filter(url => {
        const lowerUrl = url.toLowerCase();
        return !lowerUrl.includes('oliveyoung') && 
               !lowerUrl.includes('small') && 
               !lowerUrl.includes('thumb') &&
               !lowerUrl.includes('box') &&
               !lowerUrl.includes('패키지');
    });
    
    log(`\n🖼️  Step 8: 네이버 처리`);
    
    const naverProcessed = [];
    
    for (let i = 0; i < Math.min(filteredUrls.length, needed + 2); i++) {
        const imageUrl = filteredUrls[i];
        
        log(`\n   네이버 ${i + 1}: ${imageUrl.substring(0, 60)}...`);
        
        const timestamp = Date.now();
        const inputPath = `/tmp/naver-${timestamp}-${i}.jpg`;
        const croppedPath = `/tmp/naver-crop-${timestamp}-${i}.png`;
        const finalPath = `/tmp/naver-final-${timestamp}-${i}.png`;
        
        try {
            await downloadImage(imageUrl, inputPath);
            
            const dimensions = await getImageDimensions(inputPath);
            if (!dimensions || dimensions.width < 400 || dimensions.height < 400) {
                cleanupFiles(inputPath);
                continue;
            }
            
            const coords = await getCropCoordinates(imageUrl, productTitle, dimensions.width, dimensions.height);
            
            let processPath = inputPath;
            
            if (coords && coords.found) {
                const expanded = expandCoordinates(coords, dimensions.width, dimensions.height, 0.2);
                const cropSuccess = await cropImage(inputPath, croppedPath, expanded.x, expanded.y, expanded.width, expanded.height);
                if (cropSuccess) processPath = croppedPath;
            }
            
            const rembgSuccess = await removeBackgroundAndAddWhite(processPath, finalPath);
            
            if (rembgSuccess) {
                const fileName = `naver-${Id}-${i + 1}-${timestamp}.png`;
                const uploadedData = await uploadToNocoDB(finalPath, fileName);
                naverProcessed.push(uploadedData[0]);
                log(`      ✅ 저장!`);
            }
            
            cleanupFiles(inputPath, croppedPath, finalPath);
            
        } catch (error) {
            log(`      ❌ 실패:`, error.message);
            cleanupFiles(inputPath, croppedPath, finalPath);
        }
        
        if (naverProcessed.length >= needed) break;
        
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    if (naverProcessed.length === 0) {
        log(`\n⚠️  네이버 이미지 처리 실패`);
        return;
    }
    
    // Gallery 업데이트
    log(`\n➕ Step 9: Gallery 추가`);
    
    let currentGallery = [];
    try {
        const currentResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            { headers: { 'xc-token': NOCODB_API_TOKEN }, params: { where: `(Id,eq,${Id})` } }
        );
        
        if (currentResponse.data.list.length > 0) {
            currentGallery = currentResponse.data.list[0].gallery_images || [];
        }
    } catch (error) {}
    
    const updatedGallery = [...currentGallery, ...naverProcessed.slice(0, needed)];
    
    try {
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            { Id: Id, gallery_images: updatedGallery },
            { headers: { 'xc-token': NOCODB_API_TOKEN, 'Content-Type': 'application/json' } }
        );
        
        log(`✅ Gallery 업데이트: ${updatedGallery.length}개`);
        
    } catch (error) {
        log(`❌ 업데이트 실패:`, error.message);
    }
}

// ==================== 메인 ====================
async function main() {
    try {
        log('\n📥 NocoDB에서 3개 제품 가져오는 중...\n');
        
        const products = await getProductsFromNocoDB();
        
        if (!products || products.length === 0) {
            log('❌ 처리할 제품이 없습니다.');
            return;
        }
        
        log(`✅ ${products.length}개 제품 발견\n`);
        
        for (let i = 0; i < products.length; i++) {
            try {
                await processProduct(products[i], i + 1, products.length);
                
                if (i < products.length - 1) {
                    log(`\n${'='.repeat(70)}`);
                    log('⏳ 다음 제품 20초 대기...\n');
                    await new Promise(resolve => setTimeout(resolve, 20000));
                }
            } catch (productError) {
                log(`\n❌ 제품 ${i + 1} 오류:`, productError.message);
            }
        }
        
        log(`\n${'='.repeat(70)}`);
        log('🎉 Phase 4 v11 완료!');
        log('='.repeat(70));
        log(`\n✨ v11 핵심 변경:`);
        log('   ✅ v10 유지: 용량 50%+ 차이 -30점, 품질 12점 미만 -20점');
        log('   ✅ 여러 제품 감지: -40점 (개별 제품에 다른 제품 포함 방지)\n');
        
        // Gemini API 호출 통계 출력
        geminiCounter.printSummary();
        
    } catch (error) {
        log('\n❌ 오류:', error.message);
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

// 실행
main().finally(() => logStream.end());