import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PlaywrightCrawler } from 'crawlee';

dotenv.config();

const execAsync = promisify(exec);

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
const MIN_SCORE_FOR_GALLERY = 70;

console.log('🚀 Phase 2.6: 최고 이미지 선별 + 네이버 원본 이미지 보충 (v6)');
console.log('='.repeat(70));
console.log(`⚙️  설정:`);
console.log(`   - Shopify Table: ${SHOPIFY_TABLE_ID}`);
console.log(`   - 최종 크기: ${TARGET_SIZE}x${TARGET_SIZE}px`);
console.log(`   - 제품 비율: ${PRODUCT_RATIO * 100}%`);
console.log(`   - Gallery 최소 점수: ${MIN_SCORE_FOR_GALLERY}점`);
console.log(`\n✨ v6 개선 사항:`);
console.log(`   ✅ 네이버 이미지: 제품 라인 이름까지 매칭 (브랜드+제품명)`);
console.log(`   ✅ 세트 제품: 세트 이미지 우선, 없으면 개별 이미지 허용`);
console.log(`   ✅ v5 기능 유지: 여러 제품 감지, 포장박스 감지\n`);

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
        console.error(`   ⚠️  Oliveyoung 제품 정보 조회 실패:`, error.message);
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
                limit: 3,
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
        console.error('      ❌ 해상도 확인 오류:', error.message);
        return null;
    }
}

// ==================== 제품명에서 정보 추출 (v6: productLineName 추가!) ====================
function extractProductInfo(productTitle) {
    const info = {
        brandName: null,
        productLineName: null,  // ✅ v6 신규: 제품 라인 이름
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
    
    // ✅ v6 신규: 제품 라인 이름 추출 (브랜드 이후 ~ 용량 이전)
    // 예: "ongreedients Skin Barrier Calming Lotion 220ml" → "Skin Barrier Calming Lotion"
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

// ==================== v5: 여러 제품 감지 ====================
async function detectMultipleProducts(imagePath, productTitle, productInfo) {
    try {
        if (productInfo.isSetProduct) {
            console.log(`      🎁 세트 제품 → 여러 제품 검사 생략`);
            return { hasMultiple: false, reason: '세트 제품' };
        }
        
        console.log(`      🔍 여러 제품 감지 중... (개별 제품)`);
        
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
4. 정확히 눈에 보이는 실물 제품만 세어주세요

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
        
        const response = result.response.text().trim();
        
        const countMatch = response.match(/COUNT:\s*(\d+)/i);
        const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);
        
        const detectedCount = countMatch ? parseInt(countMatch[1]) : 1;
        const reason = reasonMatch ? reasonMatch[1].trim() : '응답 파싱 실패';
        
        if (detectedCount >= 2) {
            console.log(`      ❌ 여러 제품 감지됨! (${detectedCount}개) - ${reason}`);
            return { hasMultiple: true, count: detectedCount, reason };
        } else {
            console.log(`      ✅ 단일 제품 확인 (${detectedCount}개) - ${reason}`);
            return { hasMultiple: false, count: detectedCount, reason };
        }
        
    } catch (error) {
        console.error('      ❌ 여러 제품 감지 실패:', error.message);
        return { hasMultiple: false, reason: 'API 오류로 검사 생략' };
    }
}

// ==================== 포장박스 감지 ====================
async function detectPackagingBox(imagePath, productTitle) {
    try {
        console.log(`      📦 포장박스 감지 중...`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 제품 이미지를 분석해주세요.

제품명: "${productTitle}"

**질문: 이 이미지에 포장박스(패키지 상자)가 있나요?**

판단 기준:
1. 제품 본체 외에 **종이 상자**, **패키지 박스**, **포장 케이스**가 보이나요?
2. 제품이 박스 안에 들어있거나, 박스 옆에 놓여있나요?
3. "언박싱" 스타일로 제품과 박스가 함께 있나요?

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
        
        const response = result.response.text().trim();
        
        const packagingMatch = response.match(/PACKAGING:\s*(YES|NO)/i);
        const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);
        
        const hasPackaging = packagingMatch ? packagingMatch[1].toUpperCase() === 'YES' : false;
        const reason = reasonMatch ? reasonMatch[1].trim() : '응답 파싱 실패';
        
        if (hasPackaging) {
            console.log(`      ❌ 포장박스 감지됨! - ${reason}`);
            return { hasPackaging: true, reason };
        } else {
            console.log(`      ✅ 포장박스 없음 - ${reason}`);
            return { hasPackaging: false, reason };
        }
        
    } catch (error) {
        console.error('      ❌ 포장박스 감지 실패:', error.message);
        return { hasPackaging: false, reason: 'API 오류로 검사 생략' };
    }
}

// ==================== 2. 완성도 점수 (0-25점) ====================
async function calculateCompletenessScore(imagePath, productTitle, productInfo) {
    try {
        console.log(`      🔍 제품 완성도 검증 시작...`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const expectedCount = productInfo.setCount || 1;
        
        const prompt = `이 제품 이미지를 분석하여 제품이 완전한지 확인해주세요.

제품명: "${productTitle}"
예상 제품 개수: ${expectedCount}개

다음을 매우 엄격하게 검사해주세요:

1. 제품이 잘려있나요?
   - 캡(뚜껑) 부분이 잘려있나요?
   - 제품 몸통(바디)이 잘려있나요?
   - 제품 하단(바닥)이 잘려있나요?
   - 제품의 어느 부분이라도 이미지 밖으로 잘려나갔나요?

2. 제품이 완전히 보이나요?
   - 제품 전체가 이미지 안에 완전히 들어와 있나요?
   - 위에서 아래까지 모든 부분이 보이나요?

3. ${expectedCount}개 제품 모두 완전한가요?
   - 각 제품이 독립적으로 완전한가요?
   - 잘린 제품이 하나라도 있나요?

⚠️ 매우 중요: 제품의 어느 부분이라도 조금이라도 잘려있으면 불완전한 것입니다.

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
        
        const response = result.response.text().trim();
        
        const completeMatch = response.match(/COMPLETE:\s*(YES|NO)/i);
        const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);
        
        const isComplete = completeMatch ? completeMatch[1].toUpperCase() === 'YES' : false;
        const reason = reasonMatch ? reasonMatch[1].trim() : '응답 파싱 실패';
        
        if (isComplete) {
            console.log(`      ✅ 완성도: 25/25점 - ${reason}`);
            return 25;
        } else {
            console.log(`      ❌ 완성도: 0/25점 - ${reason}`);
            return 0;
        }
        
    } catch (error) {
        console.error('      ❌ 완성도 검증 실패:', error.message);
        return 0;
    }
}

// ==================== 3. 타이틀 매칭 점수 (0-30점) - v8 원본 이미지 사용! ====================
async function calculateTitleMatchScore(imagePath, productTitle, productInfo, originalImageUrl = null) {
    try {
        console.log(`      🔍 타이틀 매칭 확인 시작...`);
        
        let base64;
        let imageSource = '크롭 이미지';
        
        // ✅ v8: 원본 이미지가 있으면 원본으로 확인 (용량 텍스트 확인 가능)
        if (originalImageUrl) {
            try {
                console.log(`      📥 원본 이미지로 확인 중...`);
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
                console.log(`      ✅ 원본 이미지 로드 완료`);
            } catch (err) {
                console.log(`      ⚠️  원본 이미지 로드 실패, 크롭 이미지 사용`);
                const imageBuffer = fs.readFileSync(imagePath);
                base64 = imageBuffer.toString('base64');
            }
        } else {
            const imageBuffer = fs.readFileSync(imagePath);
            base64 = imageBuffer.toString('base64');
        }
        
        console.log(`      🖼️  검사 대상: ${imageSource}`);
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        // ✅ v8: 용량까지 정확히 확인하는 프롬프트
        const prompt = `이 제품 이미지를 **확대해서** 자세히 분석해주세요.

**확인해야 할 타겟 제품:**
- 전체 제품명: "${productTitle}"
- 브랜드: "${productInfo.brandName || 'N/A'}"
- 제품 라인: "${productInfo.productLineName || 'N/A'}"
- 용량: "${productInfo.volume || 'N/A'}"
- 세트 개수: ${productInfo.setCount || 1}개

**이미지에서 확인해주세요:**

1. **브랜드명**: 제품에 적힌 브랜드명을 읽어주세요
2. **제품 라인명**: 제품에 적힌 제품명/시리즈명을 읽어주세요
3. **용량**: 제품에 적힌 용량(ml, g 등)을 읽어주세요 (매우 중요!)
4. **제품 개수**: 실물 제품이 몇 개 보이나요?

⚠️ 매우 중요:
- 제품 라벨에 적힌 **실제 용량**을 확인하세요
- 220ml와 80ml는 **완전히 다른 제품**입니다
- 용량이 다르면 EXACT_MATCH는 반드시 NO입니다

다음 형식으로만 답변:
EXACT_MATCH: [YES/NO] (브랜드, 제품라인, 용량이 모두 일치하면 YES)
BRAND: [읽은 브랜드명 또는 UNKNOWN]
PRODUCT_LINE: [읽은 제품라인명 또는 UNKNOWN]
VOLUME: [읽은 용량 또는 UNKNOWN]
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
        
        const response = result.response.text().trim();
        console.log(`      📄 Gemini 응답:\n${response.split('\n').map(l => '         ' + l).join('\n')}`);
        
        // 응답 파싱
        const exactMatch = response.match(/EXACT_MATCH:\s*(YES|NO)/i);
        const brandMatch = response.match(/BRAND:\s*([^\n]+)/i);
        const productLineMatch = response.match(/PRODUCT_LINE:\s*([^\n]+)/i);
        const volumeMatch = response.match(/VOLUME:\s*([^\n]+)/i);
        const countMatch = response.match(/COUNT:\s*(\d+)/i);
        const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);
        
        const isExactMatch = exactMatch ? exactMatch[1].toUpperCase() === 'YES' : false;
        const detectedBrand = brandMatch ? brandMatch[1].trim().toLowerCase() : 'unknown';
        const detectedProductLine = productLineMatch ? productLineMatch[1].trim().toLowerCase() : 'unknown';
        const detectedVolume = volumeMatch ? volumeMatch[1].trim().toLowerCase() : 'unknown';
        const detectedCount = countMatch ? parseInt(countMatch[1]) : 1;
        const reason = reasonMatch ? reasonMatch[1].trim() : '';
        
        let score = 0;
        const targetBrand = (productInfo.brandName || '').toLowerCase();
        const targetLine = (productInfo.productLineName || '').toLowerCase();
        
        // ✅ v8: 정확히 일치하면 높은 점수
        if (isExactMatch) {
            score = 30;
            console.log(`      ✅ 정확한 제품 매칭! (+30점)`);
            console.log(`         → ${reason}`);
            return { score, isWrongProduct: false };
        }
        
        // ✅ v8: 브랜드 확인
        let brandOK = false;
        if (detectedBrand !== 'unknown' && targetBrand) {
            if (detectedBrand.includes(targetBrand) || targetBrand.includes(detectedBrand)) {
                brandOK = true;
                score += 10;
                console.log(`      ✅ 브랜드 일치: ${detectedBrand} (+10점)`);
            } else {
                console.log(`      ❌ 브랜드 불일치: ${detectedBrand} ≠ ${targetBrand}`);
                console.log(`         → ${reason}`);
                return { score: 0, isWrongProduct: true };
            }
        } else {
            brandOK = true; // 미확인이면 일단 통과
            score += 5;
            console.log(`      ⚠️  브랜드 미확인 (+5점)`);
        }
        
        // ✅ v8: 제품 라인 확인
        let lineOK = false;
        if (detectedProductLine !== 'unknown' && targetLine) {
            const targetWords = targetLine.split(' ').slice(0, 2).join(' ');
            const detectedWords = detectedProductLine.split(' ').slice(0, 2).join(' ');
            
            if (detectedProductLine.includes(targetWords) || targetLine.includes(detectedWords) || 
                detectedWords.includes(targetWords) || targetWords.includes(detectedWords)) {
                lineOK = true;
                score += 10;
                console.log(`      ✅ 제품 라인 일치 (+10점)`);
            } else {
                console.log(`      ❌ 제품 라인 불일치: ${detectedProductLine} ≠ ${targetLine}`);
                console.log(`         → ${reason}`);
                return { score: 0, isWrongProduct: true };
            }
        } else {
            lineOK = true;
            score += 5;
            console.log(`      ⚠️  제품 라인 미확인 (+5점)`);
        }
        
        // ✅ v8: 용량 확인 (핵심!)
        if (detectedVolume !== 'unknown' && productInfo.volume) {
            const detectedNum = parseInt(detectedVolume.match(/\d+/)?.[0] || '0');
            const expectedNum = productInfo.volumeNumber;
            
            if (expectedNum && detectedNum > 0) {
                if (detectedNum === expectedNum) {
                    score += 10;
                    console.log(`      ✅ 용량 일치: ${detectedVolume} (+10점)`);
                } else if (Math.abs(detectedNum - expectedNum) <= 10) {
                    // 10ml 이내 차이는 허용 (라벨 표기 차이)
                    score += 5;
                    console.log(`      ⚠️  용량 근사: ${detectedVolume} ≈ ${productInfo.volume} (+5점)`);
                } else {
                    // 용량이 크게 다르면 탈락
                    console.log(`      ❌ 용량 불일치: ${detectedVolume} ≠ ${productInfo.volume}`);
                    console.log(`         → 다른 용량의 제품입니다!`);
                    return { score: 0, isWrongProduct: true };
                }
            }
        } else {
            // 용량 미확인 → 브랜드 + 라인이 맞으면 통과
            if (brandOK && lineOK) {
                score += 3;
                console.log(`      ⚠️  용량 미확인, 브랜드+라인 일치로 통과 (+3점)`);
            }
        }
        
        console.log(`      📊 타이틀 매칭: ${score}/30점`);
        
        return { score, isWrongProduct: false };
        
    } catch (error) {
        console.error('      ❌ 타이틀 매칭 확인 실패:', error.message);
        return { score: 10, isWrongProduct: false };
    }
}

// ==================== 4. 세트 구성 점수 (0-20점) ====================
async function calculateSetCompositionScore(imagePath, productTitle, productInfo) {
    try {
        console.log(`      🔍 세트 구성 분석 시작...`);
        
        if (!productInfo.setCount || productInfo.setCount === 1) {
            console.log(`      ✅ 단일 제품 → 자동 20점`);
            return 20;
        }
        
        console.log(`      🎁 세트 제품: ${productInfo.setCount}개 예상`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 이미지를 분석하여 세트 제품 구성을 평가해주세요.

제품명: "${productTitle}"
예상 세트 개수: ${productInfo.setCount}개

다음 질문에 답변해주세요:

1. 명확히 보이는 실물 제품이 몇 개인가요?
2. 제품들이 어떻게 배치되어 있나요? (나란히 / 겹쳐짐 / 포개짐 / 단일)
3. "1+1", "기획전", "세트" 같은 마케팅 텍스트나 배너가 있나요?
4. 이 이미지가 세트 제품을 잘 보여주는 사진인가요?

다음 형식으로 답변하세요:
COUNT: [숫자]
LAYOUT: [나란히/겹쳐짐/포개짐/단일]
MARKETING: [YES/NO]
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
        
        const response = result.response.text().trim();
        
        const countMatch = response.match(/COUNT:\s*(\d+)/i);
        const layoutMatch = response.match(/LAYOUT:\s*([^\n]+)/i);
        const marketingMatch = response.match(/MARKETING:\s*(YES|NO)/i);
        const suitableMatch = response.match(/SUITABLE:\s*(EXCELLENT|GOOD|FAIR|POOR)/i);
        
        const detectedCount = countMatch ? parseInt(countMatch[1]) : 0;
        const layout = layoutMatch ? layoutMatch[1].trim() : 'unknown';
        const hasMarketing = marketingMatch ? marketingMatch[1].toUpperCase() === 'YES' : false;
        const suitable = suitableMatch ? suitableMatch[1].toUpperCase() : 'FAIR';
        
        let score = 0;
        
        if (detectedCount === productInfo.setCount) {
            score += 10;
        } else if (Math.abs(detectedCount - productInfo.setCount) === 1) {
            score += 5;
        }
        
        if (layout.includes('나란히')) {
            score += 5;
        } else if (layout.includes('겹쳐짐') || layout.includes('포개짐')) {
            score += 3;
        }
        
        if (hasMarketing) {
            score -= 2;
        }
        
        if (suitable === 'EXCELLENT') {
            score += 5;
        } else if (suitable === 'GOOD') {
            score += 3;
        } else if (suitable === 'FAIR') {
            score += 1;
        }
        
        score = Math.max(0, Math.min(20, score));
        console.log(`      📊 세트 구성: ${score}/20점`);
        
        return score;
        
    } catch (error) {
        console.error('      ❌ 세트 구성 분석 실패:', error.message);
        return 10;
    }
}

// ==================== 5. Gemini 품질 평가 (0-20점) ====================
async function calculateQualityScore(imagePath, productTitle) {
    try {
        console.log(`      🤖 이미지 품질 평가 중...`);
        
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 제품 이미지의 품질을 평가해주세요.

제품명: "${productTitle}"

평가 기준:
1. 선명도 (흐릿하지 않은가?)
2. 중앙 배치 (제품이 중앙에 잘 배치되었나?)
3. 배경 품질 (배경이 깨끗한가?)
4. 쇼핑몰 사용 적합성 (고객에게 보여주기 좋은가?)

0-20점 사이로 점수를 매겨주세요.
숫자만 답변하세요. (예: "18" 또는 "12")`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        const response = result.response.text().trim();
        const score = parseInt(response);
        
        if (isNaN(score) || score < 0 || score > 20) {
            console.log(`      ⚠️  유효하지 않은 점수: ${response}, 기본값 12점 사용`);
            return 12;
        }
        
        console.log(`      📊 이미지 품질: ${score}/20점`);
        return score;
        
    } catch (error) {
        console.error('      ⚠️  품질 평가 실패:', error.message);
        return 12;
    }
}

// ==================== 🆕 v6: 네이버 이미지 제품 개수 확인 (세트용) ====================
async function countProductsInImage(imagePath, productTitle) {
    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const prompt = `이 제품 이미지에서 실물 제품이 몇 개 보이나요?

제품명: "${productTitle}"

정확히 눈에 보이는 실물 제품(화장품 병, 튜브, 용기 등)만 세어주세요.
그림자, 반사, 포장박스는 제외하세요.

숫자만 답변하세요. (예: "1" 또는 "2")`;
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/png'
                }
            }
        ]);
        
        const response = result.response.text().trim();
        const count = parseInt(response);
        
        return isNaN(count) ? 1 : count;
        
    } catch (error) {
        console.error('      ❌ 제품 개수 확인 실패:', error.message);
        return 1;
    }
}

// ==================== 이미지 점수 계산 ====================
async function scoreImage(imageData, imagePath, productTitle, productInfo, index) {
    console.log(`\n   이미지 ${index + 1} 평가:`);
    console.log(`   ${'─'.repeat(66)}`);
    
    const scores = {
        resolution: 0,
        completeness: 0,
        titleMatch: 0,
        setComposition: 0,
        quality: 0
    };
    
    const resolution = getImageResolution(imagePath);
    scores.resolution = calculateResolutionScore(resolution);
    console.log(`      📏 해상도: ${scores.resolution}/30점 (${resolution?.width}x${resolution?.height})`);
    
    // 여러 제품 감지 (개별 제품인데 2개 이상이면 탈락)
    const multipleResult = await detectMultipleProducts(imagePath, productTitle, productInfo);
    
    if (multipleResult.hasMultiple) {
        console.log(`      ⚠️  개별 제품인데 ${multipleResult.count}개 감지 → 즉시 탈락!`);
        console.log(`      🎯 총점: 0/125점 (여러 제품 탈락)\n`);
        
        return {
            imageData,
            imagePath,
            resolution,
            scores,
            totalScore: 0,
            isIncomplete: false,
            isWrongProduct: false,
            hasPackaging: false,
            hasMultipleProducts: true
        };
    }
    
    // 포장박스 감지
    const packagingResult = await detectPackagingBox(imagePath, productTitle);
    
    if (packagingResult.hasPackaging) {
        console.log(`      ⚠️  포장박스 감지됨 → 즉시 탈락!`);
        console.log(`      🎯 총점: 0/125점 (포장박스 탈락)\n`);
        
        return {
            imageData,
            imagePath,
            resolution,
            scores,
            totalScore: 0,
            isIncomplete: false,
            isWrongProduct: false,
            hasPackaging: true,
            hasMultipleProducts: false
        };
    }
    
    scores.completeness = await calculateCompletenessScore(imagePath, productTitle, productInfo);
    
    if (scores.completeness === 0) {
        console.log(`      ⚠️  제품 불완전 → 나머지 평가 생략`);
        console.log(`      🎯 총점: 0/125점 (자동 탈락)\n`);
        
        return {
            imageData,
            imagePath,
            resolution,
            scores,
            totalScore: 0,
            isIncomplete: true,
            hasPackaging: false,
            hasMultipleProducts: false
        };
    }
    
    const titleMatchResult = await calculateTitleMatchScore(imagePath, productTitle, productInfo, imageData.originalUrl || null);
    
    if (titleMatchResult.isWrongProduct) {
        console.log(`      ⚠️  다른 제품 감지 → 나머지 평가 생략`);
        console.log(`      🎯 총점: 0/125점 (자동 탈락)\n`);
        
        return {
            imageData,
            imagePath,
            resolution,
            scores,
            totalScore: 0,
            isWrongProduct: true,
            hasPackaging: false,
            hasMultipleProducts: false
        };
    }
    
    scores.titleMatch = titleMatchResult.score;
    scores.setComposition = await calculateSetCompositionScore(imagePath, productTitle, productInfo);
    scores.quality = await calculateQualityScore(imagePath, productTitle);
    
    const totalScore = scores.resolution + scores.completeness + scores.titleMatch + 
                       scores.setComposition + scores.quality;
    
    console.log(`      🎯 총점: ${totalScore}/125점`);
    
    return {
        imageData,
        imagePath,
        resolution,
        scores,
        totalScore,
        isIncomplete: false,
        isWrongProduct: false,
        hasPackaging: false,
        hasMultipleProducts: false
    };
}

// ==================== 🆕 v6: 네이버 이미지 평가 (세트 제품용 - 개별 허용) ====================
async function scoreNaverImageForSet(imageData, imagePath, productTitle, productInfo, index) {
    console.log(`\n   네이버 이미지 ${index + 1} 평가 (세트 제품 - 개별 허용):`);
    console.log(`   ${'─'.repeat(66)}`);
    
    const scores = {
        resolution: 0,
        completeness: 0,
        titleMatch: 0,
        setComposition: 0,
        quality: 0
    };
    
    const resolution = getImageResolution(imagePath);
    scores.resolution = calculateResolutionScore(resolution);
    console.log(`      📏 해상도: ${scores.resolution}/30점 (${resolution?.width}x${resolution?.height})`);
    
    // ✅ v6: 세트 제품은 여러 제품 감지 생략 (개별 이미지도 허용)
    // 포장박스만 체크
    const packagingResult = await detectPackagingBox(imagePath, productTitle);
    
    if (packagingResult.hasPackaging) {
        console.log(`      ⚠️  포장박스 감지됨 → 즉시 탈락!`);
        console.log(`      🎯 총점: 0/125점 (포장박스 탈락)\n`);
        
        return {
            imageData,
            imagePath,
            resolution,
            scores,
            totalScore: 0,
            isIncomplete: false,
            isWrongProduct: false,
            hasPackaging: true,
            hasMultipleProducts: false,
            productCount: 0
        };
    }
    
    scores.completeness = await calculateCompletenessScore(imagePath, productTitle, productInfo);
    
    if (scores.completeness === 0) {
        console.log(`      ⚠️  제품 불완전 → 나머지 평가 생략`);
        console.log(`      🎯 총점: 0/125점 (자동 탈락)\n`);
        
        return {
            imageData,
            imagePath,
            resolution,
            scores,
            totalScore: 0,
            isIncomplete: true,
            hasPackaging: false,
            hasMultipleProducts: false,
            productCount: 0
        };
    }
    
    const titleMatchResult = await calculateTitleMatchScore(imagePath, productTitle, productInfo, imageData.originalUrl || null);
    
    if (titleMatchResult.isWrongProduct) {
        console.log(`      ⚠️  다른 제품 감지 → 나머지 평가 생략`);
        console.log(`      🎯 총점: 0/125점 (자동 탈락)\n`);
        
        return {
            imageData,
            imagePath,
            resolution,
            scores,
            totalScore: 0,
            isWrongProduct: true,
            hasPackaging: false,
            hasMultipleProducts: false,
            productCount: 0
        };
    }
    
    scores.titleMatch = titleMatchResult.score;
    
    // ✅ v6: 제품 개수 확인 (세트 이미지 우선순위용)
    const productCount = await countProductsInImage(imagePath, productTitle);
    console.log(`      🔢 감지된 제품 개수: ${productCount}개`);
    
    // 세트 구성 점수는 개별 이미지도 허용하므로 기본값 사용
    scores.setComposition = 10; // 중립적 점수
    scores.quality = await calculateQualityScore(imagePath, productTitle);
    
    const totalScore = scores.resolution + scores.completeness + scores.titleMatch + 
                       scores.setComposition + scores.quality;
    
    console.log(`      🎯 총점: ${totalScore}/125점`);
    
    return {
        imageData,
        imagePath,
        resolution,
        scores,
        totalScore,
        isIncomplete: false,
        isWrongProduct: false,
        hasPackaging: false,
        hasMultipleProducts: false,
        productCount: productCount  // ✅ v6: 세트 우선순위용
    };
}

// ==================== 크기 정규화 ====================
function normalizeImage(imagePath) {
    console.log('      📐 크기 정규화 중...');
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
        console.log(`      ✅ 정규화 완료: ${TARGET_SIZE}x${TARGET_SIZE}px`);
        cleanupFiles(scriptPath);
        return outputPath;
    } catch (error) {
        console.error('      ❌ 정규화 실패:', error.message);
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
        console.error('      ❌ 업로드 실패:', error.message);
        throw error;
    }
}

// ==================== 네이버 이미지 검색 ====================
async function searchNaverImages(titleKr, maxImages = 15) {
    console.log(`\n🔍 네이버 이미지 검색 시작: "${titleKr}"`);
    console.log(`   목표: 원본 이미지 ${maxImages}개 수집`);
    console.log(`   💡 전략: 썸네일 URL 파싱 → 원본 URL 추출 (클릭 불필요!)`);
    
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
                console.log(`   📄 페이지 로딩 중...`);
                
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                console.log(`   ✅ DOM 로딩 완료`);
                
                console.log(`   ⏳ 이미지 렌더링 대기 중 (5초)...`);
                await page.waitForTimeout(5000);
                
                const screenshotPath = `/tmp/naver-final-${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: false });
                console.log(`   📸 스크린샷: ${screenshotPath}`);
                
                console.log(`   🔍 썸네일 이미지 URL 추출 중...\n`);
                
                const extractedUrls = await page.evaluate((max) => {
                    const results = [];
                    
                    const thumbnails = document.querySelectorAll('img._fe_image_tab_content_thumbnail_image');
                    
                    console.log(`발견된 썸네일: ${thumbnails.length}개`);
                    
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
                                        thumbnail: thumbnailUrl.substring(0, 80),
                                        original: originalUrl
                                    });
                                }
                            }
                        } catch (e) {
                            console.error(`URL 파싱 실패 (${index}):`, e.message);
                        }
                    });
                    
                    return results.slice(0, max);
                }, maxImages);
                
                console.log(`   ✅ 추출 완료: ${extractedUrls.length}개\n`);
                
                if (extractedUrls.length > 0) {
                    console.log(`   📋 추출된 원본 URL:`);
                    extractedUrls.forEach((item, i) => {
                        console.log(`      ${i + 1}. ${item.original.substring(0, 100)}...`);
                        imageUrls.push(item.original);
                    });
                } else {
                    console.log(`   ⚠️  원본 URL을 추출하지 못했습니다.`);
                    console.log(`   💡 페이지 구조가 변경되었을 수 있습니다.`);
                }
                
            } catch (error) {
                console.error('   ❌ 페이지 처리 오류:', error.message);
            }
        },
        
        maxRequestsPerCrawl: 1,
        requestHandlerTimeoutSecs: 60
    });
    
    const searchUrl = `https://search.naver.com/search.naver?ssc=tab.image.all&where=image&sm=tab_jum&query=${encodeURIComponent(titleKr)}`;
    console.log(`   🔗 검색 URL: ${searchUrl.substring(0, 100)}...`);
    
    await crawler.run([searchUrl]);
    
    console.log(`   🧹 Playwright 메모리 해제 중...`);
    await crawler.teardown();
    console.log(`   ✅ 메모리 해제 완료`);

    console.log(`\n   ✅ 최종 수집: ${imageUrls.length}개 원본 이미지`);
    return imageUrls;
}

// ==================== 이미지 크기 확인 (Python) ====================
async function getImageDimensions(imagePath) {
    const pythonScript = `/tmp/get_dims_${Date.now()}.py`;
    const script = `import cv2
import sys

try:
    img = cv2.imread('${imagePath}')
    if img is None:
        print('ERROR: Cannot read image', file=sys.stderr)
        sys.exit(1)
    
    h, w = img.shape[:2]
    print(f'{w},{h}')
except Exception as e:
    print(f'ERROR: {str(e)}', file=sys.stderr)
    sys.exit(1)
`;
    
    fs.writeFileSync(pythonScript, script);
    
    try {
        console.log(`      🔍 이미지 크기 확인 중... (${imagePath})`);
        const { stdout, stderr } = await execAsync(`${PYTHON_PATH} "${pythonScript}"`);
        cleanupFiles(pythonScript);
        
        if (stderr && stderr.includes('ERROR')) {
            console.error(`      ❌ Python 에러: ${stderr.trim()}`);
            return null;
        }
        
        const [width, height] = stdout.trim().split(',').map(Number);
        
        if (!width || !height || isNaN(width) || isNaN(height)) {
            console.error(`      ❌ 유효하지 않은 크기: ${stdout.trim()}`);
            return null;
        }
        
        console.log(`      ✅ 크기: ${width}x${height}`);
        return { width, height };
        
    } catch (error) {
        cleanupFiles(pythonScript);
        console.error(`      ❌ 크기 확인 실패: ${error.message}`);
        if (error.stderr) {
            console.error(`      📋 stderr: ${error.stderr}`);
        }
        return null;
    }
}

// ==================== Gemini 크롭 좌표 요청 ====================
async function getCropCoordinates(imageUrl, productTitle, imageWidth, imageHeight) {
    try {
        console.log(`      🔍 크롭 좌표 요청 중...`);
        
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.naver.com'
            }
        });
        const base64 = Buffer.from(response.data).toString('base64');
        
        console.log(`      📥 이미지 다운로드 완료 (Base64 생성)`);
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        const isSetProduct = /set of \d+|세트|\d+개입|\d+개 세트|(\d+)\s*pcs?/i.test(productTitle);
        const setMessage = isSetProduct ? 
            '⚠️ 이 제품은 세트 상품입니다. 이미지에 있는 **모든 제품 본체를 함께** 포함하세요!' : 
            '이 제품은 단일 상품입니다. 1개의 제품 본체만 선택하세요.';

        const prompt = `이 이미지에서 "${productTitle}" 제품의 **본체만** 찾아주세요.

**제품 타입:**
${setMessage}

**⚠️ 매우 중요 - 반드시 지켜주세요:**
1. **제품 본체만** 포함하세요 (화장품 병, 튜브, 용기 등)
2. **포장박스/패키지 상자는 제외**하세요!
3. **종이 상자, 외부 포장은 절대 포함하지 마세요**
4. 제품이 박스와 함께 있으면, **박스는 무시하고 제품만** 선택

**크롭 지침:**
1. 이미지 크기: ${imageWidth}x${imageHeight} 픽셀
2. 제품 본체 **전체**를 포함하도록 바운딩 박스 설정
3. ${isSetProduct ? '세트 제품: 모든 제품 본체를 함께 포함' : '단일 제품: 1개의 제품 본체만'}
4. 제품의 상단부터 하단까지 **완전히** 포함
5. 제품 좌우로 약간의 **여백 포함** (제품이 잘리지 않도록)

다음 JSON 형식으로만 답변:
{
  "found": true,
  "x": 픽셀_x좌표,
  "y": 픽셀_y좌표,
  "width": 픽셀_너비,
  "height": 픽셀_높이,
  "confidence": "high/medium/low"
}

제품 본체를 찾을 수 없으면:
{
  "found": false,
  "reason": "이유"
}

JSON만 출력하고 다른 설명은 하지 마세요.`;

        console.log(`      🤖 Gemini API 호출 중... (타임아웃 30초)`);
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64,
                    mimeType: 'image/jpeg'
                }
            }
        ]);

        const responseText = result.response.text();
        console.log(`      ✅ Gemini 응답 받음`);
        
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const coords = JSON.parse(jsonMatch[0]);
            if (coords.found) {
                console.log(`      📍 좌표: (${coords.x}, ${coords.y}) ${coords.width}x${coords.height}`);
            } else {
                console.log(`      ⚠️  제품 못 찾음: ${coords.reason}`);
            }
            return coords;
        }
        
        console.log(`      ❌ JSON 파싱 실패`);
        return null;
        
    } catch (error) {
        console.error('      ❌ 크롭 좌표 요청 실패:', error.message);
        if (error.response) {
            console.error(`      📋 HTTP Status: ${error.response.status}`);
        }
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
    
    console.log(`      📐 확장: (${newX}, ${newY}) ${newWidth}x${newHeight}`);
    
    return { x: newX, y: newY, width: newWidth, height: newHeight };
}

// ==================== 이미지 크롭 ====================
async function cropImage(inputPath, outputPath, x, y, width, height) {
    const pythonScript = `/tmp/crop_${Date.now()}.py`;
    const script = `import cv2
import sys

try:
    img = cv2.imread('${inputPath}')
    if img is None:
        print('ERROR: Cannot read image', file=sys.stderr)
        sys.exit(1)
    
    h, w = img.shape[:2]
    x = max(0, min(${x}, w))
    y = max(0, min(${y}, h))
    width = min(${width}, w - x)
    height = min(${height}, h - y)
    cropped = img[y:y+height, x:x+width]
    cv2.imwrite('${outputPath}', cropped)
    print('SUCCESS')
    
except Exception as e:
    print(f'ERROR: {str(e)}', file=sys.stderr)
    sys.exit(1)
`;
    
    fs.writeFileSync(pythonScript, script);
    
    try {
        console.log(`      🔪 크롭 실행 중...`);
        const { stdout, stderr } = await execAsync(`${PYTHON_PATH} "${pythonScript}"`);
        cleanupFiles(pythonScript);
        
        if (stderr && stderr.includes('ERROR')) {
            console.error(`      ❌ Python 에러: ${stderr.trim()}`);
            return false;
        }
        
        if (fs.existsSync(outputPath)) {
            console.log(`      ✅ 크롭 완료`);
            return true;
        }
        
        console.error(`      ❌ 출력 파일 생성 실패`);
        return false;
        
    } catch (error) {
        console.error('      ❌ 크롭 실패:', error.message);
        if (error.stderr) {
            console.error(`      📋 stderr: ${error.stderr}`);
        }
        cleanupFiles(pythonScript);
        return false;
    }
}

// ==================== 배경 제거 + 흰색 배경 ====================
async function removeBackgroundAndAddWhite(inputPath, outputPath) {
    console.log(`      🎨 배경 제거 + 흰색 배경 중...`);
    
    try {
        const tempTransparent = outputPath.replace('.png', '_temp.png');
        
        console.log(`      📍 Step 1: rembg 실행...`);
        await execAsync(`${REMBG_PATH} i "${inputPath}" "${tempTransparent}"`);
        
        if (!fs.existsSync(tempTransparent)) {
            console.error(`      ❌ rembg 출력 파일 없음`);
            return false;
        }
        
        console.log(`      📍 Step 2: 흰색 배경 추가...`);
        
        const pythonScript = `/tmp/add_white_${Date.now()}.py`;
        const pythonCode = `from PIL import Image
import sys

try:
    img = Image.open('${tempTransparent}').convert('RGBA')
    white_bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
    white_bg.paste(img, (0, 0), img)
    white_bg.convert('RGB').save('${outputPath}', 'PNG')
    print('SUCCESS')
except Exception as e:
    print(f'ERROR: {str(e)}', file=sys.stderr)
    sys.exit(1)
`;
        
        fs.writeFileSync(pythonScript, pythonCode);
        const { stdout, stderr } = await execAsync(`${PYTHON_PATH} "${pythonScript}"`);
        
        cleanupFiles(tempTransparent, pythonScript);
        
        if (stderr && stderr.includes('ERROR')) {
            console.error(`      ❌ Python 에러: ${stderr.trim()}`);
            return false;
        }
        
        if (fs.existsSync(outputPath)) {
            console.log(`      ✅ 완료!`);
            return true;
        }
        
        console.error(`      ❌ 최종 파일 생성 실패`);
        return false;
        
    } catch (error) {
        console.error('      ❌ rembg 실패:', error.message);
        if (error.stderr) {
            console.error(`      📋 stderr: ${error.stderr}`);
        }
        return false;
    }
}

// ==================== 제품 처리 (핵심) ====================
async function processProduct(product, productIndex, totalProducts) {
    const { Id, validated_images } = product;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📦 제품 ${productIndex}/${totalProducts} - ID: ${Id}`);
    
    console.log(`\n🗑️  Step 0: 초기화 (오래된 이미지 제거)`);
    
    try {
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                Id: Id,
                main_image: null,
                gallery_images: null
            },
            {
                headers: {
                    'xc-token': NOCODB_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`   ✅ 초기화 완료!\n`);
    } catch (error) {
        console.error(`   ❌ 초기화 실패:`, error.message);
        return;
    }
    
    console.log(`🔍 Step 1: Oliveyoung 테이블에서 제품 정보 조회 중...`);
    
    const oliveyoungProduct = await getOliveyoungProduct(Id);
    
    let productTitle = 'Unknown Product';
    let titleKr = 'Unknown Product';
    if (oliveyoungProduct) {
        productTitle = oliveyoungProduct.title_en || oliveyoungProduct.title_kr || 'Unknown Product';
        titleKr = oliveyoungProduct.title_kr || 'Unknown Product';
        console.log(`✅ 제품명 (EN): ${productTitle}`);
        console.log(`✅ 제품명 (KR): ${titleKr}`);
    }
    
    const productInfo = extractProductInfo(productTitle);
    
    // ✅ v6: 제품 라인 이름 로깅 추가
    console.log(`📋 제품 정보:`);
    console.log(`   - 브랜드: ${productInfo.brandName || 'N/A'}`);
    console.log(`   - 제품 라인: ${productInfo.productLineName || 'N/A'}`);
    console.log(`   - 용량: ${productInfo.volume || 'N/A'}`);
    console.log(`   - 세트 여부: ${productInfo.isSetProduct ? '✅ 세트 제품' : '❌ 개별 제품'}`);
    if (productInfo.setCount) {
        console.log(`   - 세트 개수: ${productInfo.setCount}개`);
    }
    
    if (!validated_images || validated_images.length === 0) {
        console.log('⚠️  validated_images 없음, 건너뛰기');
        return;
    }
    
    console.log(`📸 검증된 이미지 (올리브영): ${validated_images.length}개\n`);
    
    console.log(`📊 Step 2: validated_images 평가 시작`);
    console.log(`${'─'.repeat(70)}`);
    
    const scoredImages = [];
    
    for (let i = 0; i < validated_images.length; i++) {
        const img = validated_images[i];
        
        let imageUrl = img.url;
        if (!imageUrl && img.path) {
            imageUrl = `${NOCODB_API_URL}/${img.path}`;
        }
        
        if (!imageUrl) {
            console.log(`\n   ⚠️  이미지 ${i + 1}: URL 없음`);
            continue;
        }
        
        const tempPath = `/tmp/score-${Id}-${i}-${Date.now()}.png`;
        
        try {
            await downloadImage(imageUrl, tempPath);
            
            const scored = await scoreImage(img, tempPath, productTitle, productInfo, i);
            scoredImages.push(scored);
            
            if (i < validated_images.length - 1) {
                console.log(`\n      ⏳ 10초 대기... (Gemini API)`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
        } catch (error) {
            console.error(`\n   ❌ 이미지 ${i + 1} 평가 실패:`, error.message);
            cleanupFiles(tempPath);
        }
    }
    
    if (scoredImages.length === 0) {
        console.log('\n⚠️  평가된 이미지 없음');
        return;
    }
    
    const completeImages = scoredImages.filter(img => 
        !img.isIncomplete && !img.isWrongProduct && !img.hasPackaging && !img.hasMultipleProducts
    );
    
    const packagingCount = scoredImages.filter(img => img.hasPackaging).length;
    const multipleCount = scoredImages.filter(img => img.hasMultipleProducts).length;
    
    console.log(`\n📊 평가 결과:`);
    console.log(`   - 올바른 제품: ${completeImages.length}개`);
    console.log(`   - 포장박스 탈락: ${packagingCount}개`);
    console.log(`   - 여러 제품 탈락: ${multipleCount}개`);
    
    if (completeImages.length === 0) {
        console.log(`\n⚠️  사용 가능한 이미지가 없습니다!`);
        scoredImages.forEach(img => cleanupFiles(img.imagePath));
        return;
    }
    
    completeImages.sort((a, b) => b.totalScore - a.totalScore);
    
    console.log(`\n✂️  Step 3: Main 1개 + Gallery 0-2개 선별`);
    
    const top1 = completeImages[0];
    const top2 = completeImages[1];
    const top3 = completeImages[2];
    
    const selectedForSave = [top1];
    
    if (top2 && top2.totalScore >= MIN_SCORE_FOR_GALLERY) {
        selectedForSave.push(top2);
    }
    
    if (top3 && top3.totalScore >= MIN_SCORE_FOR_GALLERY) {
        selectedForSave.push(top3);
    }
    
    console.log(`   - Main: 1개`);
    console.log(`   - Gallery 후보: ${selectedForSave.length - 1}개`);
    
    console.log(`\n📐 Step 4: 정규화 + 업로드`);
    
    const processedImages = [];
    
    for (let i = 0; i < selectedForSave.length; i++) {
        const selected = selectedForSave[i];
        
        console.log(`\n   ${i + 1}/${selectedForSave.length} 처리 중...`);
        
        if (!selected || !selected.imagePath || !fs.existsSync(selected.imagePath)) {
            console.log('      ❌ 유효하지 않은 이미지');
            continue;
        }
        
        const normalizedPath = normalizeImage(selected.imagePath);
        if (!normalizedPath || !fs.existsSync(normalizedPath)) {
            console.log('      ❌ 정규화 실패');
            cleanupFiles(selected.imagePath);
            continue;
        }
        
        try {
            console.log('      📤 NocoDB 업로드 중...');
            const fileName = `final-${Id}-${i + 1}-${Date.now()}.png`;
            const uploadResult = await uploadToNocoDB(normalizedPath, fileName);
            
            if (uploadResult && uploadResult.length > 0) {
                processedImages.push(uploadResult[0]);
                console.log('      ✅ 완료!');
            }
        } catch (uploadError) {
            console.error('      ❌ 업로드 오류:', uploadError.message);
        }
        
        cleanupFiles(selected.imagePath, normalizedPath);
    }
    
    if (processedImages.length === 0) {
        console.log('\n⚠️  처리된 이미지 없음');
        scoredImages.forEach(img => cleanupFiles(img.imagePath));
        return;
    }
    
    console.log(`\n💾 Step 5: main_image, gallery_images 저장`);
    
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
            {
                headers: {
                    'xc-token': NOCODB_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`✅ 저장 완료!`);
        console.log(`   - main_image: 1개`);
        console.log(`   - gallery_images: ${galleryImages.length}개`);
    } catch (error) {
        console.error(`❌ 저장 실패:`, error.message);
        scoredImages.forEach(img => cleanupFiles(img.imagePath));
        return;
    }
    
    scoredImages.forEach(img => cleanupFiles(img.imagePath));
    
    // ✅ Step 6: DB에서 실제 저장된 개수 확인
    console.log(`\n🔍 Step 6: DB에서 실제 저장된 개수 확인`);
    
    let actualMainCount = 0;
    let actualGalleryCount = 0;
    
    try {
        const verifyResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { where: `(Id,eq,${Id})` }
            }
        );
        
        if (verifyResponse.data.list.length > 0) {
            const savedProduct = verifyResponse.data.list[0];
            actualMainCount = (savedProduct.main_image && savedProduct.main_image.length > 0) ? 1 : 0;
            actualGalleryCount = (savedProduct.gallery_images && savedProduct.gallery_images.length > 0) 
                ? savedProduct.gallery_images.length 
                : 0;
            
            console.log(`   ✅ DB 확인 완료:`);
            console.log(`      - Main: ${actualMainCount}개`);
            console.log(`      - Gallery: ${actualGalleryCount}개`);
        }
    } catch (error) {
        console.error(`   ❌ DB 확인 실패:`, error.message);
        actualMainCount = 1;
        actualGalleryCount = galleryImages.length;
    }
    
    const totalCount = actualMainCount + actualGalleryCount;
    console.log(`   - 총: ${totalCount}개`);
    
    if (totalCount >= 3) {
        console.log(`\n✅ 충분함! (${totalCount}/3개) → 네이버 보충 건너뛰기`);
        console.log(`${'='.repeat(70)}`);
        return;
    }
    
    console.log(`\n⚠️  부족함! (${totalCount}/3개) → 네이버 보충 필요`);
    const needed = 3 - totalCount;
    console.log(`   필요한 개수: ${needed}개`);
    
    console.log(`\n🌐 Step 7: 네이버 원본 이미지 검색`);
    console.log(`${'='.repeat(70)}`);
    
    const targetCount = needed === 1 ? 10 : 15;
    const naverUrls = await searchNaverImages(titleKr, targetCount);
    
    if (naverUrls.length === 0) {
        console.log(`   ❌ 네이버 이미지를 찾을 수 없습니다.`);
        console.log(`   현재 상태로 완료: Main ${actualMainCount}개 + Gallery ${actualGalleryCount}개`);
        return;
    }
    
    // URL 필터링
    const filteredUrls = naverUrls.filter(url => {
        const lowerUrl = url.toLowerCase();
        
        if (lowerUrl.includes('oliveyoung.co.kr')) return false;
        if (lowerUrl.includes('small') || lowerUrl.includes('thumb')) return false;
        if (lowerUrl.includes('unbox')) return false;
        if (lowerUrl.includes('언박싱')) return false;
        if (lowerUrl.includes('package')) return false;
        if (lowerUrl.includes('패키지')) return false;
        if (lowerUrl.includes('박스')) return false;
        if (lowerUrl.includes('box')) return false;
        if (lowerUrl.includes('개봉')) return false;
        
        return true;
    });
    
    console.log(`   📋 사전 필터링: ${filteredUrls.length}개`);
    console.log(`      (올리브영, 언박싱, 패키지, 박스 키워드 제외)`);
    
    console.log(`\n🖼️  Step 8: 네이버 이미지 처리`);
    console.log(`${'─'.repeat(70)}`);
    
    const naverProcessed = [];
    
    for (let i = 0; i < Math.min(filteredUrls.length, targetCount); i++) {
        const imageUrl = filteredUrls[i];
        
        console.log(`\n   네이버 ${i + 1}/${Math.min(filteredUrls.length, targetCount)}:`);
        console.log(`   URL: ${imageUrl.substring(0, 80)}...`);
        
        const timestamp = Date.now();
        const inputPath = `/tmp/naver-input-${timestamp}-${i}.jpg`;
        const croppedPath = `/tmp/naver-cropped-${timestamp}-${i}.png`;
        const finalPath = `/tmp/naver-final-${timestamp}-${i}.png`;
        
        try {
            console.log(`      ⬇️  다운로드 시작...`);
            await downloadImage(imageUrl, inputPath);
            console.log(`      📥 다운로드 완료`);
            
            const dimensions = await getImageDimensions(inputPath);
            if (!dimensions || dimensions.width < 500 || dimensions.height < 500) {
                console.log(`      ❌ 해상도 부족: ${dimensions?.width}x${dimensions?.height}`);
                cleanupFiles(inputPath);
                continue;
            }
            
            console.log(`      📏 원본: ${dimensions.width}x${dimensions.height} ✓`);
            
            const coords = await getCropCoordinates(
                imageUrl,
                productTitle,
                dimensions.width,
                dimensions.height
            );
            
            if (!coords || !coords.found) {
                console.log(`      ⚠️  제품 위치 찾기 실패 - 원본 rembg만 적용`);
                
                const rembgSuccess = await removeBackgroundAndAddWhite(inputPath, finalPath);
                
                if (rembgSuccess) {
                    const fileName = `naver-${Id}-${i + 1}-${timestamp}.png`;
                    const uploadedData = await uploadToNocoDB(finalPath, fileName);
                    naverProcessed.push(uploadedData[0]);
                    console.log(`      📤 원본 rembg 처리 & 저장 완료!`);
                }
                
                cleanupFiles(inputPath, finalPath);
                continue;
            }
            
            const expandedCoords = expandCoordinates(
                coords,
                dimensions.width,
                dimensions.height,
                0.2
            );
            
            const cropSuccess = await cropImage(
                inputPath,
                croppedPath,
                expandedCoords.x,
                expandedCoords.y,
                expandedCoords.width,
                expandedCoords.height
            );
            
            if (!cropSuccess) {
                console.log(`      ⚠️  크롭 실패 - 원본 rembg만 적용`);
                
                const rembgSuccess = await removeBackgroundAndAddWhite(inputPath, finalPath);
                
                if (rembgSuccess) {
                    const fileName = `naver-${Id}-${i + 1}-${timestamp}.png`;
                    const uploadedData = await uploadToNocoDB(finalPath, fileName);
                    naverProcessed.push(uploadedData[0]);
                    console.log(`      📤 원본 rembg 처리 & 저장 완료!`);
                }
                
                cleanupFiles(inputPath, croppedPath, finalPath);
                continue;
            }
            
            const rembgSuccess = await removeBackgroundAndAddWhite(croppedPath, finalPath);
            
            if (rembgSuccess) {
                const fileName = `naver-${Id}-${i + 1}-${timestamp}.png`;
                const uploadedData = await uploadToNocoDB(finalPath, fileName);
                
                naverProcessed.push(uploadedData[0]);
                console.log(`      📤 크롭 & rembg 완료!`);
            }
            
            cleanupFiles(inputPath, croppedPath, finalPath);
            
        } catch (error) {
            console.error(`      ❌ 처리 실패:`, error.message);
            cleanupFiles(inputPath, croppedPath, finalPath);
        }
        
        if (i < Math.min(filteredUrls.length, targetCount) - 1) {
            console.log(`\n      ⏳ 10초 대기... (Gemini API)`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    
    console.log(`\n✅ 네이버 처리 완료: ${naverProcessed.length}개`);
    
    if (naverProcessed.length === 0) {
        console.log(`   ⚠️  처리된 네이버 이미지 없음`);
        console.log(`   현재 상태로 완료: Main ${actualMainCount}개 + Gallery ${actualGalleryCount}개`);
        return;
    }
    
    console.log(`\n📊 Step 9: 네이버 이미지 평가`);
    console.log(`${'─'.repeat(70)}`);
    
    const naverScored = [];
    const naverTempPaths = [];
    
    for (let i = 0; i < naverProcessed.length; i++) {
        const img = naverProcessed[i];
        
        let imageUrl = img.url;
        if (!imageUrl && img.path) {
            imageUrl = `${NOCODB_API_URL}/${img.path}`;
        }
        
        if (!imageUrl) continue;
        
        const tempPath = `/tmp/score-naver-${Id}-${i}-${Date.now()}.png`;
        
        try {
            await downloadImage(imageUrl, tempPath);
            
            // ✅ v6: 세트 제품은 별도 평가 함수 사용 (개별 이미지 허용)
            let scored;
            if (productInfo.isSetProduct) {
                scored = await scoreNaverImageForSet(img, tempPath, productTitle, productInfo, i);
            } else {
                scored = await scoreImage(img, tempPath, productTitle, productInfo, i);
            }
            
            // ✅ v6: 타이틀 매칭 통과하고 점수 70점 이상만 허용
            if (scored.totalScore >= MIN_SCORE_FOR_GALLERY && 
                !scored.isIncomplete && 
                !scored.isWrongProduct && 
                !scored.hasPackaging &&
                !scored.hasMultipleProducts) {
                naverScored.push(scored);
                naverTempPaths.push(tempPath);
            } else {
                cleanupFiles(tempPath);
            }
            
            if (i < naverProcessed.length - 1) {
                console.log(`\n      ⏳ 10초 대기... (Gemini API)`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
        } catch (error) {
            console.error(`\n   ❌ 네이버 이미지 ${i + 1} 평가 실패:`, error.message);
            cleanupFiles(tempPath);
        }
    }
    
    console.log(`\n📊 네이버 평가 결과: 70점 이상 & 제품 라인 일치 ${naverScored.length}개`);
    
    if (naverScored.length === 0) {
        console.log(`   ⚠️  적합한 네이버 이미지 없음`);
        console.log(`   💡 제품 라인이 정확히 일치하는 이미지가 없습니다.`);
        return;
    }
    
    // ✅ v6: 세트 제품이면 세트 이미지 우선 정렬
    if (productInfo.isSetProduct) {
        console.log(`\n🎁 세트 제품 → 세트 이미지 우선 정렬`);
        const expectedCount = productInfo.setCount || 2;
        
        // 세트 이미지(여러 개) > 개별 이미지(1개) 순으로 정렬
        naverScored.sort((a, b) => {
            const aIsSet = (a.productCount || 1) >= expectedCount;
            const bIsSet = (b.productCount || 1) >= expectedCount;
            
            // 세트 이미지 우선
            if (aIsSet && !bIsSet) return -1;
            if (!aIsSet && bIsSet) return 1;
            
            // 같은 타입이면 점수 순
            return b.totalScore - a.totalScore;
        });
        
        console.log(`   정렬 결과:`);
        naverScored.forEach((img, idx) => {
            const type = (img.productCount || 1) >= expectedCount ? '세트' : '개별';
            console.log(`   ${idx + 1}. [${type}] ${img.productCount || 1}개 - ${img.totalScore}점`);
        });
    } else {
        naverScored.sort((a, b) => b.totalScore - a.totalScore);
    }
    
    const naverSelected = naverScored.slice(0, needed);
    
    console.log(`\n📐 Step 10: 네이버 이미지 정규화`);
    
    const naverFinal = [];
    
    for (let i = 0; i < naverSelected.length; i++) {
        const selected = naverSelected[i];
        
        console.log(`\n   ${i + 1}/${naverSelected.length} 정규화 중...`);
        
        if (!selected || !selected.imagePath || !fs.existsSync(selected.imagePath)) {
            console.log('      ❌ 유효하지 않은 이미지');
            continue;
        }
        
        const normalizedPath = normalizeImage(selected.imagePath);
        if (!normalizedPath || !fs.existsSync(normalizedPath)) {
            console.log('      ❌ 정규화 실패');
            continue;
        }
        
        try {
            console.log('      📤 NocoDB 업로드 중...');
            const fileName = `naver-final-${Id}-${i + 1}-${Date.now()}.png`;
            const uploadResult = await uploadToNocoDB(normalizedPath, fileName);
            
            if (uploadResult && uploadResult.length > 0) {
                naverFinal.push(uploadResult[0]);
                console.log('      ✅ 완료!');
            }
        } catch (uploadError) {
            console.error('      ❌ 업로드 오류:', uploadError.message);
        }
        
        cleanupFiles(normalizedPath);
    }
    
    if (naverFinal.length === 0) {
        console.log('\n⚠️  최종 네이버 이미지 없음');
        naverTempPaths.forEach(path => cleanupFiles(path));
        return;
    }
    
    console.log(`\n🧹 임시 파일 정리 중...`);
    naverTempPaths.forEach(path => cleanupFiles(path));
    console.log(`   ✅ ${naverTempPaths.length}개 파일 삭제 완료`);
    
    console.log(`\n➕ Step 11: Gallery에 네이버 이미지 추가`);
    
    let currentGallery = [];
    try {
        const currentResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { where: `(Id,eq,${Id})` }
            }
        );
        
        if (currentResponse.data.list.length > 0) {
            const currentProduct = currentResponse.data.list[0];
            currentGallery = (currentProduct.gallery_images && currentProduct.gallery_images.length > 0)
                ? currentProduct.gallery_images
                : [];
        }
    } catch (error) {
        console.error(`   ⚠️  현재 Gallery 조회 실패`);
    }
    
    const updatedGallery = [...currentGallery, ...naverFinal];
    
    try {
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                Id: Id,
                gallery_images: updatedGallery
            },
            {
                headers: {
                    'xc-token': NOCODB_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`\n✅ Gallery 업데이트 완료!`);
        console.log(`   - Main: 1개 (유지)`);
        console.log(`   - Gallery: ${updatedGallery.length}개`);
        console.log(`      - 올리브영: ${currentGallery.length}개`);
        console.log(`      - 네이버: ${naverFinal.length}개`);
        
    } catch (error) {
        console.error(`❌ Gallery 업데이트 실패:`, error.message);
    }
    
    console.log(`${'='.repeat(70)}`);
}

// ==================== 메인 함수 ====================
async function main() {
    try {
        console.log('\n📥 NocoDB에서 3개 제품 가져오는 중...\n');
        
        const products = await getProductsFromNocoDB();
        
        if (!products || products.length === 0) {
            console.log('❌ 처리할 제품이 없습니다.');
            return;
        }
        
        console.log(`✅ ${products.length}개 제품 발견\n`);
        
        for (let i = 0; i < products.length; i++) {
            try {
                await processProduct(products[i], i + 1, products.length);
                
                if (i < products.length - 1) {
                    console.log(`\n${'='.repeat(70)}`);
                    console.log('⏳ 다음 제품 처리 전 20초 대기...\n');
                    await new Promise(resolve => setTimeout(resolve, 20000));
                }
            } catch (productError) {
                console.error(`\n❌ 제품 ${i + 1} 처리 중 오류 발생:`, productError.message);
                console.log('   다음 제품으로 계속 진행...\n');
            }
        }
        
        console.log(`\n${'='.repeat(70)}`);
        console.log('🎉 Phase 2.6 완료!');
        console.log('='.repeat(70));
        console.log(`✅ ${products.length}개 제품 처리 완료`);
        console.log(`\n✨ v6 개선 사항:`);
        console.log('   ✅ 네이버 이미지: 제품 라인 이름까지 매칭');
        console.log('   ✅ 세트 제품: 세트 이미지 우선, 없으면 개별 허용');
        console.log('   ✅ v5 기능 유지: 여러 제품 감지, 포장박스 감지\n');
        
    } catch (error) {
        console.error('\n❌ 오류:', error.message);
        if (error.response) {
            console.error('응답 데이터:', error.response.data);
        }
    }
}

main();