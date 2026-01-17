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

// 로그 디렉토리 생성
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 시드니 시간 포맷
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

// 로그 파일 설정
const LOG_FILENAME = `phase1_${getSydneyTimeForFile()}.log`;
const LOG_PATH = path.join(LOG_DIR, LOG_FILENAME);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

// 로그 함수 (콘솔 + 파일)
function log(...args) {
    const timestamp = `[${getSydneyTime()}]`;
    const message = args.join(' ');
    console.log(timestamp, message);
    logStream.write(`${timestamp} ${message}\n`);
}

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID || 'mufuxqsjgqcvh80';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// OpenAI 클라이언트
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

log('🚀 Phase 1: 제품 상세 스크래핑 (스마트 필드별 체크)');
log('='.repeat(70));
log('🔧 설정 확인:');
log(`- NocoDB URL: ${NOCODB_API_URL}`);
log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);
log(`- OpenAI API: ${OPENAI_API_KEY ? '✅ 설정됨' : '❌ 없음'}`);
log(`- 시간대: ${SYDNEY_TIMEZONE} (시드니)`);
log(`- 로그 파일: ${LOG_PATH}`);
log('');
log('📋 스마트 필드 체크 모드:');
log('   - 각 필드별로 개별 체크');
log('   - 빈 필드만 채우고, 있는 필드는 스킵');
log('   - 이미지 있으면 이미지 다운로드 스킵 (시간 절약)');
log('');

// ==================== 전역 변수 ====================
let processedCount = 0;
let successCount = 0;
let skippedCount = 0;
let failedCount = 0;

// 통계
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
    imagesSkipped: 0
};

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
    
    // 페이지 방문이 필요한지 (타이틀, 가격, 설명, 이미지 중 하나라도 없으면 방문 필요)
    missing.needsPageVisit = missing.needsTitleKr || missing.needsPriceOriginal || 
                              missing.needsDescription || missing.needsImages;
    
    // 아무것도 필요 없으면 완전 스킵
    missing.isComplete = !missing.needsTitleKr && !missing.needsTitleEn && 
                         !missing.needsPriceOriginal && !missing.needsDescription &&
                         !missing.needsDescriptionEn && !missing.needsImages;
    
    return missing;
}

// ==================== 타이틀 클리닝 함수 ====================
function cleanProductTitle(rawTitle) {
    if (!rawTitle) return '';
    
    let cleaned = rawTitle;
    
    // 1단계: 괄호와 그 안의 내용 제거 ([], (), 【】, 〔〕 등)
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '');  // [내용]
    cleaned = cleaned.replace(/\([^)]*\)/g, '');   // (내용)
    cleaned = cleaned.replace(/【[^】]*】/g, '');   // 【내용】
    cleaned = cleaned.replace(/〔[^〕]*〕/g, '');   // 〔내용〕
    cleaned = cleaned.replace(/\{[^}]*\}/g, '');   // {내용}
    
    // 2단계: 제거할 키워드 목록 (프로모션/증정 관련)
    const removeKeywords = [
        // 기획/증정 관련
        '기획증정',
        '기획 증정', 
        '증정기획',
        '증정 기획',
        '기획세트',
        '기획 세트',
        '기획',
        '증정',
        // 한정/추가 관련
        '한정기획',
        '한정 기획',
        '한정판',
        '한정',
        '추가증정',
        '추가 증정',
        '추가',
        // 올리브영 프로모션
        '어워즈',
        '올영픽',
        '올영세일',
        '올영딜',
        '올영추천',
        // 프로모션 일반
        '단독기획',
        '단독',
        '특가',
        '세일',
        'SALE',
        '행사',
        '이벤트',
        '스페셜',
        'Special',
        '리미티드',
        'Limited',
        '에디션',
        'Edition',
        '선물세트',
        '선물 세트',
        '홀리데이',
        'Holiday',
        '베스트',
        'Best',
        '인기',
        '추천',
        'NEW',
        '신상',
        '신제품',
        '런칭',
    ];
    
    // 키워드 제거 (대소문자 구분 없이)
    for (const keyword of removeKeywords) {
        const regex = new RegExp(keyword, 'gi');
        cleaned = cleaned.replace(regex, '');
    }
    
    // 3단계: 연속 공백 제거 및 앞뒤 공백 정리
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
}

// ==================== 타이틀에서 용량 추출 ====================
function extractVolumeFromTitle(title) {
    if (!title) return null;
    
    const volumes = [];
    
    // 패턴 1: 100ml, 50g, 220mL 등
    const volumePattern = /(\d+)\s*(ml|mL|ML|g|G)/gi;
    let match;
    
    while ((match = volumePattern.exec(title)) !== null) {
        volumes.push(match[1] + match[2].toLowerCase());
    }
    
    // 패턴 2: "2개", "2입", "2매" 등 - 같은 제품 여러 개
    const countMatch = title.match(/(\d+)\s*(개|입|매)/);
    
    if (countMatch && volumes.length > 0) {
        const count = parseInt(countMatch[1]);
        const baseVolume = volumes[0]; // 첫 번째 용량
        
        if (count > 1) {
            // 용량 × 개수로 표시 (예: "220ml × 2")
            return `${baseVolume} × ${count}`;
        }
    }
    
    // 용량이 여러 개면 + 로 연결 (예: "100ml + 100ml")
    if (volumes.length > 1) {
        return volumes.join(' + ');
    }
    
    // 용량이 하나면 그대로
    if (volumes.length === 1) {
        return volumes[0];
    }
    
    return null;
}

// ==================== OpenAI 번역 함수 ====================
async function translateToEnglish(koreanText) {
    if (!openai || !koreanText) {
        log('   ⚠️  번역 스킵: OpenAI API 키 없음 또는 텍스트 없음');
        return null;
    }
    
    try {
        log(`   🌐 번역 중: "${koreanText.substring(0, 50)}..."`);
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional translator specializing in Korean beauty products.
Translate the Korean product name to English.
Keep brand names in their original form (e.g., 아벤느 → Avène, VT → VT).
Keep volume/quantity units (ml, g, 매, 입, 개) in their common English forms.
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

// ==================== 설명 번역 함수 ====================
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
Translate the Korean product description to natural English.
Keep brand names and technical terms accurate.
Output ONLY the translated text, no explanations.`
                },
                {
                    role: 'user',
                    content: koreanDescription.substring(0, 1000) // 최대 1000자
                }
            ],
            max_tokens: 500,
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
                    limit: limit
                }
            }
        );

        const products = response.data.list;
        log(`✅ ${products.length}개 제품 가져옴`);
        
        // 빈 필드 통계
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
async function downloadImage(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.oliveyoung.co.kr/'
            }
        });
        
        const buffer = Buffer.from(response.data);
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        log(`   📥 다운로드 완료 (${sizeMB} MB)`);
        
        return buffer;

    } catch (error) {
        log(`   ❌ 다운로드 실패: ${error.message}`);
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

// ==================== NocoDB: 제품 업데이트 (통합) ====================
async function updateProduct(recordId, updateData) {
    try {
        log(`📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        
        // 업데이트할 필드들 로그
        const fields = Object.keys(updateData).filter(k => k !== 'Id');
        log(`📋 업데이트 필드: ${fields.join(', ')}`);
        
        // product_images가 있으면 2단계 처리 (기존 삭제 후 저장)
        if (updateData.product_images) {
            // 1단계: 기존 이미지 삭제
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
        
        // 2단계: 새 데이터 저장
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

// ==================== 이미지 처리 (다운로드 & 업로드) ====================
async function processProductImages(product, imageUrls) {
    try {
        if (imageUrls.length === 0) {
            log('❌ 메인 갤러리 이미지를 찾을 수 없습니다.');
            return [];
        }
        
        log(`📊 추출된 이미지: ${imageUrls.length}개`);
        imageUrls.slice(0, 5).forEach((url, i) => {
            log(`   ${i + 1}. ${url.substring(0, 70)}...`);
        });
        
        const maxImages = Math.min(imageUrls.length, 7);
        log(`📥 ${maxImages}개 이미지 다운로드 & 업로드 중...`);
        
        const uploadedFiles = [];
        
        for (let i = 0; i < maxImages; i++) {
            const url = imageUrls[i];
            log(`${i + 1}/${maxImages}: ${url.substring(0, 60)}...`);
            
            const buffer = await downloadImage(url);
            if (!buffer) continue;
            
            const filename = `gallery-${product.Id}-${i + 1}-${Date.now()}.jpg`;
            const uploadResult = await uploadToNocoDB(buffer, filename);
            
            if (uploadResult) {
                uploadedFiles.push(uploadResult);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // attachment 형식으로 변환
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

// ==================== 메인 ====================
async function main() {
    log('🚀 Phase 1: 메인 갤러리 이미지 + 타이틀/가격/설명 추출');
    log('='.repeat(70));
    log('');
    
    let crawler = null;
    
    try {
        // 1. NocoDB에서 제품 가져오기
        const products = await getOliveyoungProducts(
            parseInt(process.env.PRODUCT_LIMIT) || 3, 
            0
        );
        
        if (products.length === 0) {
            log('⚠️  처리할 제품이 없습니다.');
            return;
        }
        
        // 페이지 방문이 필요한 제품만 필터링
        const productsToProcess = products.filter(p => {
            const missing = checkMissingFields(p);
            return missing.needsPageVisit;
        });
        
        log(`📋 페이지 방문 필요: ${productsToProcess.length}/${products.length}개`);
        log('');
        
        if (productsToProcess.length === 0) {
            log('✅ 모든 제품이 이미 완전합니다. 처리할 것이 없습니다.');
            return;
        }
        
        const totalProducts = productsToProcess.length;
        
        // 2. Crawlee 설정
        crawler = new PlaywrightCrawler({
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--single-process'
                    ]
                }
            },
            
            // 각 URL 처리 시 실행되는 함수
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
                
                try {
                    // 페이지 로딩
                    log(`📄 페이지 로딩 중...`);
                    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                    await page.waitForTimeout(3000);
                    
                    const updateData = {};
                    let hasUpdates = false;
                    
                    // ==================== 타이틀/가격/설명 추출 (✅ 개선된 셀렉터) ====================
                    if (missingFields.needsTitleKr || missingFields.needsPriceOriginal || missingFields.needsDescription) {
                        log(`📊 웹페이지에서 정보 추출 중...`);
                        
                        const productData = await page.evaluate(() => {
                            const result = {
                                rawTitle: '',
                                priceOriginal: 0,
                                priceDiscount: 0,
                                description: '',
                                imageUrls: []
                            };
                            
                            // ===== 타이틀 추출 (✅ 올리브영 2024-2025 구조) =====
                            const titleEl = document.querySelector('.goodsDetailInfo_title_name_unity') ||
                                           document.querySelector('[class*="title_name_unity"]') ||
                                           document.querySelector('[class*="title"]') || 
                                           document.querySelector('h1') ||
                                           document.querySelector('[class*="name"]');
                            
                            if (titleEl && titleEl.textContent.trim().length > 5) {
                                result.rawTitle = titleEl.textContent.trim();
                            }
                            
                            // ===== 가격 추출 (✅ 한 덩어리에서 정규식으로 추출) =====
                            const priceEl = document.querySelector('[class*="price"]');
                            
                            if (priceEl) {
                                const priceText = priceEl.textContent;
                                // 정규식으로 모든 가격 추출 (예: "47,800원37%29,700원")
                                const prices = priceText.match(/[\d,]+원/g);
                                
                                if (prices && prices.length >= 2) {
                                    // 첫 번째: 정가, 두 번째: 할인가
                                    result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                    result.priceDiscount = parseInt(prices[1].replace(/[^0-9]/g, ''));
                                } else if (prices && prices.length === 1) {
                                    // 할인 없는 경우
                                    result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                    result.priceDiscount = result.priceOriginal;
                                }
                            }
                            
                            // 정가가 할인가보다 작으면 스왑 (데이터 정합성)
                            if (result.priceOriginal && result.priceDiscount && 
                                result.priceOriginal < result.priceDiscount) {
                                const temp = result.priceOriginal;
                                result.priceOriginal = result.priceDiscount;
                                result.priceDiscount = temp;
                            }
                            
                            // ===== 이미지 수집 (✅ 올리브영 이미지만, 최대 40개) =====
                            const images = document.querySelectorAll('img[src*="image.oliveyoung.co.kr"]');
                            
                            images.forEach(img => {
                                const src = img.src || img.getAttribute('src');
                                if (src && !result.imageUrls.includes(src)) {
                                    // 썸네일 URL을 원본 URL로 변환
                                    const fullSrc = src.replace('/thumbnails/', '/');
                                    result.imageUrls.push(fullSrc);
                                }
                            });
                            
                            // 최대 40개로 제한
                            result.imageUrls = result.imageUrls.slice(0, 40);
                            
                            // ===== 상세설명 추출 =====
                            const descEl = document.querySelector('[class*="detail"]') ||
                                          document.querySelector('[class*="description"]') ||
                                          document.querySelector('.prd_detail');
                            
                            if (descEl) {
                                result.description = descEl.textContent.trim().substring(0, 500);
                            }
                            
                            // ===== 타이틀 기반 용량 추출 (설명에 추가) =====
                            if (result.rawTitle) {
                                const volumes = [];
                                const volumePattern = /(\d+)\s*(ml|mL|ML|g|G)/gi;
                                let volMatch;
                                while ((volMatch = volumePattern.exec(result.rawTitle)) !== null) {
                                    volumes.push(volMatch[1] + volMatch[2].toLowerCase());
                                }
                                
                                const countMatch = result.rawTitle.match(/(\d+)\s*(개|입|매)/);
                                
                                let volumeStr = '';
                                if (countMatch && volumes.length > 0) {
                                    const count = parseInt(countMatch[1]);
                                    if (count > 1) {
                                        volumeStr = `${volumes[0]} × ${count}`;
                                    }
                                }
                                
                                if (!volumeStr && volumes.length > 1) {
                                    volumeStr = volumes.join(' + ');
                                } else if (!volumeStr && volumes.length === 1) {
                                    volumeStr = volumes[0];
                                }
                                
                                if (volumeStr) {
                                    result.description = `용량: ${volumeStr}\n${result.description}`;
                                }
                            }
                            
                            return result;
                        });
                        
                        log(`📋 추출된 정보:`);
                        log(`   타이틀: ${productData.rawTitle ? productData.rawTitle.substring(0, 60) + '...' : '❌ 없음'}`);
                        log(`   정가: ${productData.priceOriginal ? '₩' + productData.priceOriginal.toLocaleString() : '❌ 없음'}`);
                        log(`   할인가: ${productData.priceDiscount ? '₩' + productData.priceDiscount.toLocaleString() : '❌ 없음'}`);
                        log(`   설명: ${productData.description ? productData.description.substring(0, 50) + '...' : '❌ 없음'}`);
                        log(`   이미지: ${productData.imageUrls.length}개`);
                        
                        // ✅ 1. 타이틀 처리 (title_kr이 없을 때만)
                        if (missingFields.needsTitleKr && productData.rawTitle) {
                            const cleanedTitle = cleanProductTitle(productData.rawTitle);
                            updateData.title_kr = cleanedTitle;
                            hasUpdates = true;
                            stats.titleKrFilled++;
                            
                            log(`📝 타이틀 클리닝:`);
                            log(`   원본: "${productData.rawTitle.substring(0, 60)}"`);
                            log(`   정제: "${cleanedTitle}"`);
                            
                            // title_en도 없으면 번역
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
                            
                            // title_kr은 있는데 title_en만 없는 경우
                            if (missingFields.needsTitleEn && product.title_kr) {
                                log(`   ℹ️  title_en 없음 → 기존 title_kr로 번역`);
                                const englishTitle = await translateToEnglish(product.title_kr);
                                if (englishTitle) {
                                    updateData.title_en = englishTitle;
                                    hasUpdates = true;
                                    stats.titleEnFilled++;
                                }
                            }
                        } else {
                            log(`⚠️  타이틀 추출 실패`);
                        }
                        
                        // ✅ 2. 가격 처리 (price_original이 없을 때만)
                        if (missingFields.needsPriceOriginal && productData.priceOriginal) {
                            updateData.price_original = productData.priceOriginal;
                            hasUpdates = true;
                            stats.priceFilled++;
                            
                            // price_discount도 설정
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
                        } else {
                            log(`⚠️  가격 추출 실패`);
                        }
                        
                        // ✅ 3. 설명 처리 (description이 없을 때만)
                        if (missingFields.needsDescription && productData.description) {
                            updateData.description = productData.description;
                            hasUpdates = true;
                            stats.descriptionFilled++;
                            
                            log(`📄 설명: ${productData.description.substring(0, 60)}...`);
                            
                            // description_en도 없으면 번역
                            if (missingFields.needsDescriptionEn) {
                                const englishDesc = await translateDescriptionToEnglish(productData.description);
                                if (englishDesc) {
                                    updateData.description_en = englishDesc;
                                }
                            }
                        } else if (!missingFields.needsDescription) {
                            log(`📄 설명: 이미 있음 → 스킵`);
                            stats.descriptionSkipped++;
                        }
                        
                        // ✅ 4. 이미지 처리 (images가 없을 때만)
                        if (missingFields.needsImages && productData.imageUrls.length > 0) {
                            log(`🖼️  이미지 처리 중...`);
                            
                            // 이미지 다운로드 & 업로드
                            const attachments = await processProductImages(product, productData.imageUrls);
                            
                            if (attachments.length > 0) {
                                updateData.product_images = attachments;
                                hasUpdates = true;
                                stats.imagesFilled++;
                                log(`✅ ${attachments.length}개 이미지 처리 완료`);
                            }
                        } else if (!missingFields.needsImages) {
                            log(`🖼️  이미지: 이미 있음 → 스킵`);
                            stats.imagesSkipped++;
                        } else {
                            log(`⚠️  이미지 추출 실패`);
                        }
                    }
                    
                    // ==================== NocoDB 업데이트 ====================
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
            },
            
            // 설정
            maxRequestsPerCrawl: 1000,
            maxConcurrency: 1,
            requestHandlerTimeoutSecs: 180
        });
        
        // 3. 모든 URL을 한 번에 전달
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
        
        await crawler.run(requests);
        
        // ✅ Crawler 정리 (메모리 누수 방지)
        await crawler.teardown();
        
        // 4. 최종 결과
        log('');
        log('='.repeat(70));
        log('🎉 Phase 1 완료!');
        log('='.repeat(70));
        log(`✅ 성공: ${successCount}/${totalProducts}개 제품`);
        log(`⏭️  스킵: ${skippedCount}/${totalProducts}개 제품`);
        log(`❌ 실패: ${failedCount}/${totalProducts}개 제품`);
        
        log(`📊 필드별 통계:`);
        log(`   - title_kr: ${stats.titleKrFilled}개 채움, ${stats.titleKrSkipped}개 스킵`);
        log(`   - title_en: ${stats.titleEnFilled}개 채움, ${stats.titleEnSkipped}개 스킵`);
        log(`   - price: ${stats.priceFilled}개 채움, ${stats.priceSkipped}개 스킵`);
        log(`   - description: ${stats.descriptionFilled}개 채움, ${stats.descriptionSkipped}개 스킵`);
        log(`   - images: ${stats.imagesFilled}개 채움, ${stats.imagesSkipped}개 스킵`);
        
        log(`📁 로그 파일: ${LOG_PATH}`);
        log(`💡 다음 단계: Phase 2 실행`);
        log(`   node phase2-ai-generate.js`);
        
    } catch (error) {
        log('❌ 치명적 오류:', error.message);
        log(error.stack);
    } finally {
        // ✅ 크롤러 정리 확인
        if (crawler) {
            try {
                await crawler.teardown();
            } catch (e) {
                // 이미 종료됨
            }
        }
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