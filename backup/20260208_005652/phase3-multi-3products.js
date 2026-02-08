import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import dotenv from 'dotenv';
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
const LOG_FILENAME = `phase3_${getSydneyTimeForFile()}.log`;
const LOG_PATH = path.join(LOG_DIR, LOG_FILENAME);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(...args) {
    const timestamp = `[${getSydneyTime()}]`;
    const message = args.join(' ');
    console.log(timestamp, message);
    logStream.write(`${timestamp} ${message}\n`);
}

// ==================== 환경 변수 ====================
const PRODUCT_LIMIT = parseInt(process.env.PRODUCT_LIMIT) || 3;
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const NOCODB_BASE_URL = process.env.NOCODB_API_URL;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const PYTHON_PATH = '/root/copychu-scraper/rembg-env/bin/python';
const REMBG_PATH = '/root/copychu-scraper/rembg-env/bin/rembg';

const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);

log('🚀 Phase 2.5 (Phase 3): 제품 이미지 처리 (v2.2 - 프로모션 감지 강화)');
log('='.repeat(70));
log('🔧 설정 확인:');
log(`   - NocoDB URL: ${NOCODB_BASE_URL}`);
log(`   - Shopify Table: ${SHOPIFY_TABLE_ID}`);
log(`   - Python: ${PYTHON_PATH}`);
log(`   - rembg: ${REMBG_PATH}`);
log(`   - 로그 파일: ${LOG_PATH}`);
if (deletedLogs.length > 0) {
    log(`🧹 오래된 로그 ${deletedLogs.length}개 삭제됨 (${LOG_RETENTION_DAYS}일 이상)`);
}
log('');
log('🎯 처리 규칙:');
log('   ✅ 프레임만 있는 이미지 → 그대로 통과 (이미 rembg 처리됨)');
log('   ❌ 모델/사람 사진 → 완전 제외');
log('   ⚠️  배지/스티커 있는 이미지 → 배지 부분만 크롭해서 제거');
log('   🆕 개별 제품인데 여러 개 보임 → 1개만 크롭');
log('   🆕 세트 제품인데 1개만 보임 → 건너뛰기');
log('   🆕 1+1/프로모션 이미지 → 강력 차단');
log('='.repeat(70) + '\n');

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
            `${NOCODB_BASE_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
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
        log(`      ⚠️  Oliveyoung 제품 정보 조회 실패:`, error.message);
        return null;
    }
}

async function imageUrlToBase64(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000
        });
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = response.headers['content-type'] || 'image/png';
        return { base64, mimeType };
    } catch (error) {
        log(`❌ 다운로드 실패:`, error.message);
        return null;
    }
}

async function downloadImage(imageUrl, outputPath) {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(outputPath, response.data);
}

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
        return { width, height };
    } catch (error) {
        cleanupFiles(pythonScript);
        return null;
    }
}

// ==================== 이미지 분석 (모델/배지 감지) - v2.2 프로모션 강화 ====================
async function analyzeImage(imageUrl, productTitle, isSetProduct) {
    try {
        log('      🔍 이미지 분석 중...');
        const imageData = await imageUrlToBase64(imageUrl);
        if (!imageData) return { action: 'SKIP', reason: '다운로드 실패' };

        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const productTypeInfo = isSetProduct 
            ? '🎁 세트 제품: 여러 개가 함께 보여야 정상입니다.'
            : '📦 개별 제품: 1개만 보여야 정상입니다.';

        // ✅ v2.2: 프로모션 필터링 대폭 강화된 프롬프트
        const prompt = `이 이미지를 분석해주세요.

**제품 타입:** ${productTypeInfo}

**⚠️ 최우선 확인사항 (이것부터 먼저 확인!):**
다음 중 하나라도 해당하면 무조건 SKIP_BANNER:
- "1+1", "2+1", "+1" 텍스트가 이미지 어디든 보임
- 동일한 제품 2개가 "+" 기호와 함께 나란히 배치됨
- 프로모션/광고 그래픽이나 텍스트가 이미지 면적의 10% 이상 차지
- 올리브영 로고나 텍스트가 보임
- 가격 정보나 할인율이 보임
- 한국어 프로모션 텍스트 (예: "특가", "증정", "한정", "세일", "기획", "사은품" 등)
- rembg 처리 후 남은 장식 잔재물 (별, 달, 하트, 리본, 색상 조각 등)이 면적 10% 이상

⚠️ 중요 예외: 제품 용기 자체에 인쇄된 브랜드명/제품명 텍스트는 프로모션이 아닙니다!

**판단 기준 (위 최우선 확인 후):**

1. PASS (그대로 사용)
   - 제품 이미지 (프레임이 있어도 OK)
   - 배경이 이미 흰색이거나 제거된 상태
   - 배지/스티커가 없음
   - ${isSetProduct ? '세트 제품의 경우: 여러 제품이 함께 보임' : '개별 제품의 경우: 제품이 1개만 보임'}
   
2. CROP_BADGE (배지만 크롭해서 제거)
   - 제품 이미지이지만 코너에 배지/스티커가 있음
   - 예: "Slow Aging", "NEW", "BEST", "HOT", "ONLY", "GLOWPICK" 등의 원형/사각형 배지
   - ⚠️ 배지가 이미지 면적의 10% 이상이면 CROP_BADGE 대신 SKIP_BANNER
   - 배지 위치를 알려주세요

3. CROP_SINGLE (개별 제품 1개만 크롭) - ⚠️ 개별 제품 전용!
   - ${isSetProduct ? '세트 제품에서는 사용하지 마세요!' : '개별 제품인데 이미지에 2개 이상의 제품이 보임'}
   - ⚠️ 2개 제품이 "+" 기호와 함께 있으면 CROP_SINGLE이 아닌 SKIP_BANNER!
   - 가장 선명하고 중앙에 있는 1개만 크롭해야 함
   
4. SKIP_MODEL (제외 - 모델/사람)
   - 사람/모델이 등장하는 사진
   - 제품을 들고 있거나 사용하는 모습
   - 얼굴이 보이는 사진
   
5. SKIP_BANNER (제외 - 배너/광고)
   - 제품 없이 텍스트/광고만 있음
   - 여러 제품이 작게 나열된 카탈로그
   - 1+1, 2+1 프로모션 이미지
   - 프로모션 텍스트/그래픽이 이미지의 10% 이상

6. SKIP_SET_MISMATCH (제외 - 세트 불일치) - ⚠️ 세트 제품 전용!
   - ${isSetProduct ? '세트 제품인데 이미지에 1개만 보임 (세트 구성이 안 맞음)' : '개별 제품에서는 사용하지 마세요!'}

**중요:** 
- 컬러 프레임(핑크, 노랑 등)만 있는 이미지는 PASS입니다
- 배지가 있으면 위치를 정확히 알려주세요 (top-left, top-right, bottom-left, bottom-right)
- 이미지에서 **실제 제품이 몇 개 보이는지** 꼭 세어주세요

다음 형식으로만 답변:
ACTION: [PASS/CROP_BADGE/CROP_SINGLE/SKIP_MODEL/SKIP_BANNER/SKIP_SET_MISMATCH]
PRODUCT_COUNT: [숫자]
BADGE_LOCATION: [top-left/top-right/bottom-left/bottom-right/none]
REASON: [한 줄 설명]`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageData.base64, mimeType: imageData.mimeType } }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('analyzeImage');

        const response = result.response.text();
        
        const actionMatch = response.match(/ACTION:\s*(PASS|CROP_BADGE|CROP_SINGLE|SKIP_MODEL|SKIP_BANNER|SKIP_SET_MISMATCH)/i);
        const productCountMatch = response.match(/PRODUCT_COUNT:\s*(\d+)/i);
        const badgeLocationMatch = response.match(/BADGE_LOCATION:\s*([^\n]+)/i);
        const reasonMatch = response.match(/REASON:\s*(.+)/i);
        
        let action = actionMatch ? actionMatch[1].toUpperCase() : 'PASS';
        const productCount = productCountMatch ? parseInt(productCountMatch[1]) : 1;
        const badgeLocation = badgeLocationMatch ? badgeLocationMatch[1].trim().toLowerCase() : 'none';
        const reason = reasonMatch ? reasonMatch[1].trim() : '';

        // ✅ v2.2: 프로모션 힌트 감지 - reason에서 1+1, 프로모션 키워드 확인
        const hasPromoHint = /1\+1|2\+1|\+1|프로모션|promotion|증정|기획|특가|세일|한정|사은품|올리브영|oliveyoung/i.test(reason);

        // ✅ v2.2: 개별 제품인데 2개 이상 + 프로모션 힌트 → 무조건 SKIP_BANNER
        if (!isSetProduct && productCount >= 2 && action === 'CROP_SINGLE' && hasPromoHint) {
            action = 'SKIP_BANNER';
            log(`      🔄 자동 변경: CROP_SINGLE → SKIP_BANNER (프로모션 힌트 + ${productCount}개 감지)`);
        }

        // 추가 검증: 개별/세트 로직 적용
        if (!isSetProduct && productCount >= 2 && action === 'PASS') {
            // ✅ v2.2: 프로모션 힌트가 있으면 SKIP_BANNER
            if (hasPromoHint) {
                action = 'SKIP_BANNER';
                log(`      🔄 자동 변경: PASS → SKIP_BANNER (프로모션 힌트 + ${productCount}개 감지)`);
            } else {
                action = 'CROP_SINGLE';
                log(`      🔄 자동 변경: PASS → CROP_SINGLE (개별 제품인데 ${productCount}개 감지)`);
            }
        }
        
        if (isSetProduct && productCount === 1 && action === 'PASS') {
            action = 'SKIP_SET_MISMATCH';
            log(`      🔄 자동 변경: PASS → SKIP_SET_MISMATCH (세트인데 1개만 감지)`);
        }

        if (action === 'PASS') {
            log(`      ✅ 통과 (그대로 사용) - 제품 ${productCount}개`);
        } else if (action === 'CROP_BADGE') {
            log(`      ⚠️  배지 감지됨 (위치: ${badgeLocation}) → 크롭 필요`);
        } else if (action === 'CROP_SINGLE') {
            log(`      🔪 개별 제품 크롭 필요 (${productCount}개 중 1개만 선택)`);
        } else if (action === 'SKIP_MODEL') {
            log(`      ❌ 모델/사람 사진 → 건너뛰기`);
        } else if (action === 'SKIP_BANNER') {
            log(`      ❌ 배너/광고/프로모션 → 건너뛰기`);
        } else if (action === 'SKIP_SET_MISMATCH') {
            log(`      ❌ 세트 불일치 (${productCount}개만 보임) → 건너뛰기`);
        }
        
        return { action, productCount, badgeLocation, reason };
        
    } catch (error) {
        log('      ⚠️  이미지 분석 실패:', error.message);
        return { action: 'PASS', productCount: 1, reason: 'API 오류 - 기본 통과' };
    }
}

// ==================== 배지 제거 크롭 좌표 ====================
async function getBadgeCropCoordinates(imageUrl, productTitle, imageWidth, imageHeight, badgeLocation) {
    try {
        log(`      🎯 배지 제거 크롭 좌표 요청 중...`);
        const imageData = await imageUrlToBase64(imageUrl);
        if (!imageData) return null;

        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const isSetProduct = /set of \d+|세트|\d+개입|\d+개 세트|(\d+)\s*pcs?/i.test(productTitle);

        const prompt = `이 이미지에서 **${badgeLocation}** 위치에 있는 배지/스티커를 제외하고 제품만 크롭해주세요.

**이미지 크기:** ${imageWidth}x${imageHeight} 픽셀
**배지 위치:** ${badgeLocation}
**제품 타입:** ${isSetProduct ? '세트 상품' : '단일 상품'}

**크롭 규칙:**
1. 제품 전체가 포함되어야 함 (잘리면 안 됨)
2. ${badgeLocation} 코너의 배지/스티커는 제외
3. 배지가 있는 방향으로는 여백을 최소화
4. 제품 주변에 적당한 여백 포함 (20-50픽셀)
5. ⚠️ 크롭 결과가 원본의 50% 미만이면 안 됩니다!

다음 JSON 형식으로만 답변:
{
  "x": 숫자,
  "y": 숫자,
  "width": 숫자,
  "height": 숫자
}

JSON만 출력하세요.`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageData.base64, mimeType: imageData.mimeType } }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('getBadgeCropCoordinates');

        const response = result.response.text();
        
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const coords = JSON.parse(jsonMatch[0]);
            
            // ✅ v2.2: 크롭 결과가 원본의 50% 미만이면 거부
            const cropArea = coords.width * coords.height;
            const originalArea = imageWidth * imageHeight;
            if (cropArea < originalArea * 0.5) {
                log(`      ⚠️  크롭 영역이 원본의 ${Math.round(cropArea/originalArea*100)}% → 너무 작음, 건너뛰기`);
                return null;
            }
            
            log(`      📍 크롭 좌표: (${coords.x}, ${coords.y}) ${coords.width}x${coords.height}`);
            return coords;
        }
        
        return null;
        
    } catch (error) {
        log('      ❌ 좌표 요청 실패:', error.message);
        return null;
    }
}

// ==================== 개별 제품 1개만 크롭 좌표 ====================
async function getSingleProductCropCoordinates(imageUrl, productTitle, imageWidth, imageHeight) {
    try {
        log(`      🎯 개별 제품 크롭 좌표 요청 중...`);
        const imageData = await imageUrlToBase64(imageUrl);
        if (!imageData) return null;

        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const prompt = `이 이미지에서 **가장 메인이 되는 제품 1개만** 크롭해주세요.

**이미지 크기:** ${imageWidth}x${imageHeight} 픽셀
**제품명:** ${productTitle}

**선택 기준 (우선순위):**
1. 가장 크고 선명한 제품
2. 중앙에 가까운 제품
3. 완전히 보이는 제품 (잘린 것 제외)

**크롭 규칙:**
1. 선택한 제품 1개만 포함
2. 다른 제품은 반드시 제외
3. 제품 전체가 포함되어야 함 (캡, 바디, 하단 모두)
4. 제품 주변에 여백 10-20% 포함
5. ⚠️ 크롭 결과가 원본의 50% 미만이면 안 됩니다!

⚠️ 중요: 여러 제품이 보이더라도 반드시 1개만 선택하세요!

다음 JSON 형식으로만 답변:
{
  "x": 숫자,
  "y": 숫자,
  "width": 숫자,
  "height": 숫자,
  "selected_reason": "선택 이유"
}

JSON만 출력하세요.`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageData.base64, mimeType: imageData.mimeType } }
        ]);
        
        // Gemini API 호출 추적
        trackGeminiCall('getSingleProductCropCoordinates');

        const response = result.response.text();
        
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const coords = JSON.parse(jsonMatch[0]);
            
            // ✅ v2.2: 크롭 결과가 원본의 50% 미만이면 거부
            const cropArea = coords.width * coords.height;
            const originalArea = imageWidth * imageHeight;
            if (cropArea < originalArea * 0.5) {
                log(`      ⚠️  크롭 영역이 원본의 ${Math.round(cropArea/originalArea*100)}% → 너무 작음, 건너뛰기`);
                return null;
            }
            
            log(`      📍 크롭 좌표: (${coords.x}, ${coords.y}) ${coords.width}x${coords.height}`);
            if (coords.selected_reason) {
                log(`      💡 선택 이유: ${coords.selected_reason}`);
            }
            return coords;
        }
        
        return null;
        
    } catch (error) {
        log('      ❌ 좌표 요청 실패:', error.message);
        return null;
    }
}

// ==================== 이미지 크롭 ====================
async function cropImage(inputPath, outputPath, x, y, width, height) {
    const pythonScript = `/tmp/crop_${Date.now()}.py`;
    const script = `import cv2
import sys

try:
    img = cv2.imread('${inputPath}')
    if img is None:
        print('Error: Cannot read image')
        sys.exit(1)
    
    h, w = img.shape[:2]
    x = max(0, min(${x}, w))
    y = max(0, min(${y}, h))
    width = min(${width}, w - x)
    height = min(${height}, h - y)
    cropped = img[y:y+height, x:x+width]
    cv2.imwrite('${outputPath}', cropped)
    
except Exception as e:
    print(f'Error: {str(e)}')
    sys.exit(1)
`;
    
    fs.writeFileSync(pythonScript, script);
    
    try {
        await execAsync(`${PYTHON_PATH} "${pythonScript}"`);
        cleanupFiles(pythonScript);
        
        if (fs.existsSync(outputPath)) {
            log(`      🔪 크롭 완료`);
            return true;
        }
        return false;
        
    } catch (error) {
        log('      ❌ 크롭 실패:', error.message);
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
            log(`      ✅ 배경 제거 완료!`);
            return true;
        }
        return false;
        
    } catch (error) {
        log('      ❌ rembg 실패:', error.message);
        return false;
    }
}

// ==================== NocoDB 업로드 ====================
async function uploadToNocoDB(filePath, fileName) {
    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), fileName);
        
        const response = await axios.post(
            `${NOCODB_BASE_URL}/api/v2/storage/upload`,
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

// ==================== NocoDB 업데이트 ====================
async function updateProduct(recordId, validatedImages) {
    try {
        log(`\n🗑️  기존 validated_images 삭제 중...`);
        await axios.patch(
            `${NOCODB_BASE_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            { Id: recordId, validated_images: null },
            { headers: { 'xc-token': NOCODB_API_TOKEN, 'Content-Type': 'application/json' } }
        );
        
        log(`💾 새 validated_images 저장 중...`);
        await axios.patch(
            `${NOCODB_BASE_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            { Id: recordId, validated_images: validatedImages },
            { headers: { 'xc-token': NOCODB_API_TOKEN, 'Content-Type': 'application/json' } }
        );
        
        return true;
    } catch (error) {
        log(`❌ 저장 실패:`, error.message);
        return false;
    }
}

// ==================== 제품 처리 ====================
async function processProduct(product, productIndex, totalProducts) {
    const { Id, ai_product_images } = product;
    
    log(`\n${'='.repeat(70)}`);
    log(`📦 제품 ${productIndex}/${totalProducts} - ID: ${Id}`);
    log(`🔍 Oliveyoung 테이블에서 제품 정보 조회 중...`);
    
    const oliveyoungProduct = await getOliveyoungProduct(Id);
    
    let productTitle = 'Unknown Product';
    let isSetProduct = false;
    // ✅ v2.2: 프로모션 키워드 감지 (세트로 취급하지 않음!)
    let hasPromoKeyword = false;
    
    if (oliveyoungProduct) {
        productTitle = oliveyoungProduct.title_en || oliveyoungProduct.title_kr || oliveyoungProduct.title || 'Unknown Product';
        const fullTitle = `${oliveyoungProduct.title_kr || ''} ${oliveyoungProduct.title_en || ''}`;
        
        // ✅ v2.2: 프로모션 키워드 먼저 체크 (이것들은 세트가 아님!)
        hasPromoKeyword = /증정|기획|[+]\s*1|사은품|한정|특가|세일/i.test(fullTitle);
        
        if (hasPromoKeyword) {
            // 프로모션 키워드가 있으면 세트가 아닌 개별 제품으로 처리
            isSetProduct = false;
            log(`⚠️  프로모션 키워드 감지 → 개별 제품으로 처리 (세트 아님!)`);
        } else {
            // 프로모션이 아닌 경우에만 세트 판단
            isSetProduct = /set of \d+|세트|\d+개입|\d+개 세트|(\d+)\s*pcs?|듀오|duo|트윈|twin/i.test(productTitle);
        }
        
        log(`✅ 제품명: ${productTitle}`);
        if (isSetProduct) {
            log(`🎁 세트 제품 감지!`);
        } else if (hasPromoKeyword) {
            log(`📦 개별 제품 (프로모션 키워드 포함 - 증정품 이미지 필터링 강화)`);
        } else {
            log(`📦 개별 제품`);
        }
    } else {
        log(`⚠️  Oliveyoung 제품 정보 없음`);
    }
    
    log(`📸 이미지 개수: ${ai_product_images.length}\n`);

    const validatedImages = [];
    let passCount = 0;
    let badgeCropCount = 0;
    let singleCropCount = 0;
    let skippedModelCount = 0;
    let skippedBannerCount = 0;
    let skippedSetMismatchCount = 0;

    for (let i = 0; i < ai_product_images.length; i++) {
        const img = ai_product_images[i];
        
        let imageUrl = img.url;
        if (!imageUrl && img.path) {
            imageUrl = `${NOCODB_BASE_URL}/${img.path}`;
        }

        if (!imageUrl) {
            log(`\n   ⚠️  이미지 ${i + 1}: URL 없음`);
            continue;
        }

        log(`\n🖼️  이미지 ${i + 1}/${ai_product_images.length} 처리:`);
        log(`   ${'─'.repeat(66)}`);
        
        const timestamp = Date.now();
        const inputPath = `/tmp/input-${timestamp}-${i}.png`;
        const croppedPath = `/tmp/cropped-${timestamp}-${i}.png`;
        const finalPath = `/tmp/final-${timestamp}-${i}.png`;
        
        try {
            // 1단계: 이미지 분석
            const analysis = await analyzeImage(imageUrl, productTitle, isSetProduct);
            
            // 모델/배너/세트불일치 이미지는 건너뛰기
            if (analysis.action === 'SKIP_MODEL') {
                skippedModelCount++;
                if (i < ai_product_images.length - 1) {
                    log(`\n      ⏳ 3초 대기 중...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                continue;
            }
            
            if (analysis.action === 'SKIP_BANNER') {
                skippedBannerCount++;
                if (i < ai_product_images.length - 1) {
                    log(`\n      ⏳ 3초 대기 중...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                continue;
            }
            
            if (analysis.action === 'SKIP_SET_MISMATCH') {
                skippedSetMismatchCount++;
                if (i < ai_product_images.length - 1) {
                    log(`\n      ⏳ 3초 대기 중...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                continue;
            }
            
            // 2단계: 이미지 다운로드
            await downloadImage(imageUrl, inputPath);
            log(`      📥 다운로드 완료`);
            
            // 3단계: 처리 방식 결정
            if (analysis.action === 'PASS') {
                passCount++;
                
                // ✅ v2.2: Phase 2에서 이미 rembg 처리됨 → 중복 rembg 생략, 그대로 복사
                fs.copyFileSync(inputPath, finalPath);
                log(`      ✅ Phase 2 처리 완료 이미지 사용 (rembg 생략)`);
                
                const fileName = `final-${Id}-${i + 1}-${timestamp}.png`;
                const uploadedData = await uploadToNocoDB(finalPath, fileName);
                validatedImages.push(uploadedData[0]);
                log(`      📤 저장 완료! (그대로 통과)`);
                
            } else if (analysis.action === 'CROP_BADGE') {
                badgeCropCount++;
                
                const dimensions = await getImageDimensions(inputPath);
                if (!dimensions) {
                    log(`      ❌ 이미지 크기 확인 실패`);
                    cleanupFiles(inputPath);
                    continue;
                }
                
                log(`      📏 원본: ${dimensions.width}x${dimensions.height}`);
                
                const coords = await getBadgeCropCoordinates(
                    imageUrl, productTitle, dimensions.width, dimensions.height, analysis.badgeLocation
                );
                
                if (coords) {
                    const cropSuccess = await cropImage(inputPath, croppedPath, coords.x, coords.y, coords.width, coords.height);
                    
                    if (cropSuccess) {
                        // ✅ v2.2: 크롭된 이미지 그대로 사용 (rembg 생략)
                        fs.copyFileSync(croppedPath, finalPath);
                        log(`      ✅ 크롭 완료 이미지 사용 (rembg 생략)`);
                        
                        const fileName = `final-${Id}-${i + 1}-${timestamp}.png`;
                        const uploadedData = await uploadToNocoDB(finalPath, fileName);
                        validatedImages.push(uploadedData[0]);
                        log(`      📤 저장 완료! (배지 제거됨)`);
                    } else {
                        // ✅ v2.2: 크롭 실패 → 원본 저장 대신 건너뛰기!
                        log(`      ⚠️  크롭 실패 → 건너뛰기 (원본에 배지 포함)`);
                    }
                } else {
                    // ✅ v2.2: 좌표 획득 실패 → 원본 저장 대신 건너뛰기!
                    log(`      ⚠️  좌표 획득 실패 → 건너뛰기 (원본에 배지 포함)`);
                }
                
            } else if (analysis.action === 'CROP_SINGLE') {
                singleCropCount++;
                
                const dimensions = await getImageDimensions(inputPath);
                if (!dimensions) {
                    log(`      ❌ 이미지 크기 확인 실패`);
                    cleanupFiles(inputPath);
                    continue;
                }
                
                log(`      📏 원본: ${dimensions.width}x${dimensions.height}`);
                
                const coords = await getSingleProductCropCoordinates(imageUrl, productTitle, dimensions.width, dimensions.height);
                
                if (coords) {
                    const cropSuccess = await cropImage(inputPath, croppedPath, coords.x, coords.y, coords.width, coords.height);
                    
                    if (cropSuccess) {
                        // ✅ v2.2: 크롭된 이미지 그대로 사용 (rembg 생략)
                        fs.copyFileSync(croppedPath, finalPath);
                        log(`      ✅ 크롭 완료 이미지 사용 (rembg 생략)`);
                        
                        const fileName = `final-${Id}-${i + 1}-${timestamp}.png`;
                        const uploadedData = await uploadToNocoDB(finalPath, fileName);
                        validatedImages.push(uploadedData[0]);
                        log(`      📤 저장 완료! (개별 제품 1개 크롭됨)`);
                    } else {
                        // ✅ v2.2: 크롭 실패 → 원본 저장 대신 건너뛰기!
                        log(`      ⚠️  크롭 실패 → 건너뛰기 (원본에 여러 제품 포함)`);
                    }
                } else {
                    // ✅ v2.2: 좌표 획득 실패 → 원본 저장 대신 건너뛰기!
                    log(`      ⚠️  좌표 획득 실패 → 건너뛰기 (원본에 여러 제품 포함)`);
                }
            }
            
            cleanupFiles(inputPath, croppedPath, finalPath);
            
        } catch (error) {
            log(`      ❌ 처리 실패:`, error.message);
            cleanupFiles(inputPath, croppedPath, finalPath);
        }
        
        // ✅ v2.2: API Rate Limiting (10초 → 6초)
        if (i < ai_product_images.length - 1) {
            log(`\n      ⏳ 6초 대기 중... (Gemini API Rate Limit)`);
            await new Promise(resolve => setTimeout(resolve, 6000));
        }
    }

    // NocoDB에 저장
    if (validatedImages.length > 0) {
        await updateProduct(Id, validatedImages);
        
        log(`\n📊 결과:`);
        log(`   - 원본 이미지: ${ai_product_images.length}개`);
        log(`   - 처리된 이미지: ${validatedImages.length}개`);
        log(`   - 그대로 통과: ${passCount}개`);
        log(`   - 배지 제거: ${badgeCropCount}개`);
        log(`   - 개별 크롭: ${singleCropCount}개`);
        log(`   - 모델 사진 제외: ${skippedModelCount}개`);
        log(`   - 배너/프로모션 제외: ${skippedBannerCount}개`);
        log(`   - 세트 불일치 제외: ${skippedSetMismatchCount}개`);
    } else {
        log('\n⚠️  처리된 이미지 없음');
    }
}

// ==================== 메인 함수 ====================
async function processProducts() {
    try {
        log(`📥 NocoDB에서 ${PRODUCT_LIMIT}개 제품 가져오는 중...\n`);
        
        const response = await axios.get(
            `${NOCODB_BASE_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    limit: PRODUCT_LIMIT,
                    where: '(ai_product_images,notnull)'
                }
            }
        );

        const products = response.data.list;
        
        if (!products || products.length === 0) {
            log('❌ 처리할 제품이 없습니다.');
            log('\n💡 Phase 2를 먼저 실행했는지 확인하세요:');
            log('   node phase2-ai-generate.js\n');
            logStream.end();
            return;
        }

        log(`✅ ${products.length}개 제품 발견\n`);

        for (let i = 0; i < products.length; i++) {
            await processProduct(products[i], i + 1, products.length);
            
            // ✅ v2.2: 제품 간 대기 20초 → 10초
            if (i < products.length - 1) {
                log(`\n${'='.repeat(70)}`);
                log('⏳ 다음 제품 처리 전 10초 대기... (Gemini API Rate Limit)\n');
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
        
        // 최종 결과
        log(`\n${'='.repeat(70)}`);
        log('🎉 Phase 2.5 (Phase 3) 완료! (v2.2 프로모션 감지 강화)');
        log('='.repeat(70));
        log(`✅ ${products.length}개 제품 처리 완료`);
        log(`\n📝 NocoDB에서 확인: ${NOCODB_BASE_URL}`);
        log('   → tb_shopify_products 테이블');
        log('   → validated_images 필드\n');
        log('🎯 v2.2 처리 규칙:');
        log('   ✅ 프레임만 있는 이미지 → 그대로 통과 (rembg 중복 생략)');
        log('   ❌ 모델/사람 사진 → 제외');
        log('   ⚠️  배지 있는 이미지 → 배지만 크롭 제거 (실패 시 건너뛰기)');
        log('   🆕 개별 제품 + 여러 개 보임 → 1개만 크롭 (실패 시 건너뛰기)');
        log('   🆕 세트 제품 + 1개만 보임 → 제외');
        log('   🆕 1+1/프로모션 이미지 → 강력 차단');
        log('   🆕 증정/기획 키워드 → 세트가 아닌 개별 제품으로 처리\n');
        
        // Gemini API 호출 통계 출력
        geminiCounter.printSummary();
        
        log(`📝 로그 파일: ${LOG_PATH}`);
        log('💡 다음 단계:');
        log('   node phase4-final-data.js');
        
    } catch (error) {
        log('\n❌ 오류:', error.message);
        if (error.response) {
            log('응답 데이터:', JSON.stringify(error.response.data));
        }
    }
    
    logStream.end();
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
processProducts();