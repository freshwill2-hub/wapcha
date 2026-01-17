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

const LOG_FILENAME = `phase1_${getSydneyTimeForFile()}.log`;
const LOG_PATH = path.join(LOG_DIR, LOG_FILENAME);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

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

// ✅ 메모리 관리 설정
const BATCH_SIZE = 10;
const MEMORY_CHECK_INTERVAL = 5;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

log('🚀 Phase 1: 제품 상세 스크래핑 (v2.0 - 타이틀 & 이미지 수정)');
log('='.repeat(70));
log('🔧 설정 확인:');
log(`- NocoDB URL: ${NOCODB_API_URL}`);
log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);
log(`- OpenAI API: ${OPENAI_API_KEY ? '✅ 설정됨' : '❌ 없음'}`);
log(`- 시간대: ${SYDNEY_TIMEZONE} (시드니)`);
log(`- 로그 파일: ${LOG_PATH}`);
log('');
log('🆕 v2.0 수정 사항:');
log('   ✅ 타이틀 셀렉터 확장 (meta, JSON-LD 포함)');
log('   ✅ 이미지 404 문제 해결 (우선순위 정렬)');
log('   ✅ data-src, data-origin 속성 지원');
log('   ✅ 페이지 로딩 대기 시간 증가');
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
    images404Skipped: 0
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

// ==================== 타이틀 클리닝 함수 ====================
function cleanProductTitle(rawTitle) {
    if (!rawTitle) return '';
    
    let cleaned = rawTitle;
    
    // 괄호 제거
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
    cleaned = cleaned.replace(/\([^)]*\)/g, '');
    cleaned = cleaned.replace(/【[^】]*】/g, '');
    cleaned = cleaned.replace(/〔[^〕]*〕/g, '');
    cleaned = cleaned.replace(/\{[^}]*\}/g, '');
    
    // 제거할 키워드
    const removeKeywords = [
        '기획증정', '기획 증정', '증정기획', '증정 기획', '기획세트', '기획 세트',
        '기획', '증정', '한정기획', '한정 기획', '한정판', '한정',
        '추가증정', '추가 증정', '추가', '어워즈', '올영픽', '올영세일',
        '올영딜', '올영추천', '단독기획', '단독', '특가', '세일', 'SALE',
        '행사', '이벤트', '스페셜', 'Special', '리미티드', 'Limited',
        '에디션', 'Edition', '선물세트', '선물 세트', '홀리데이', 'Holiday',
        '베스트', 'Best', '인기', '추천', 'NEW', '신상', '신제품', '런칭',
    ];
    
    for (const keyword of removeKeywords) {
        const regex = new RegExp(keyword, 'gi');
        cleaned = cleaned.replace(regex, '');
    }
    
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
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
                    limit: limit
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

// ==================== 이미지 다운로드 (✅ 404 처리 개선) ====================
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

// ==================== 메인 ====================
async function main() {
    log('🚀 Phase 1: 메인 갤러리 이미지 + 타이틀/가격/설명 추출 (v2.0)');
    log('='.repeat(70));
    log('');
    
    logMemoryUsage('시작');
    
    let crawler = null;
    
    try {
        const products = await getOliveyoungProducts(
            parseInt(process.env.PRODUCT_LIMIT) || 3, 
            0
        );
        
        if (products.length === 0) {
            log('⚠️  처리할 제품이 없습니다.');
            return;
        }
        
        const productsToProcess = products.filter(p => {
            const missing = checkMissingFields(p);
            return missing.needsPageVisit;
        });
        
        log(`📋 페이지 방문 필요: ${productsToProcess.length}/${products.length}개`);
        log('');
        
        if (productsToProcess.length === 0) {
            log('✅ 모든 제품이 이미 완전합니다.');
            return;
        }
        
        const totalProducts = productsToProcess.length;
        
        crawler = new PlaywrightCrawler({
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
                    // ✅ 수정: 페이지 로딩 대기 시간 증가
                    log(`📄 페이지 로딩 중...`);
                    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                    
                    // ✅ JavaScript 렌더링 대기 (타이틀이 동적 로딩될 수 있음)
                    await page.waitForTimeout(3000);
                    
                    // ✅ 제품명 요소가 나타날 때까지 추가 대기
                    try {
                        await page.waitForSelector('p.prd_name, .prd_name, [class*="goods_name"]', { 
                            timeout: 5000 
                        });
                        log(`   ✅ 제품명 요소 감지됨`);
                    } catch (e) {
                        log(`   ⚠️  제품명 요소 대기 시간 초과 (계속 진행)`);
                    }
                    
                    const updateData = {};
                    let hasUpdates = false;
                    
                    if (missingFields.needsTitleKr || missingFields.needsPriceOriginal || missingFields.needsDescription) {
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
                                imageUrls: []
                            };
                            
                            // ===== ✅ 수정: 타이틀 추출 (확장된 셀렉터) =====
                            const titleSelectors = [
                                // 올리브영 최신 구조 (2024-2025)
                                'p.prd_name',
                                '.prd_name',
                                '.goods-name',
                                '.prd-info p.prd_name',
                                
                                // 상품 상세 영역
                                '.prd_detail_box .prd_name',
                                '.goods_detail_box .prd_name',
                                '[class*="goodsName"]',
                                '[class*="goods_name"]',
                                
                                // 제목 영역 대체
                                '.pdtInfoWrap .prd_name',
                                '.prd_info_area .prd_name',
                                '#Contents .prd_name',
                                
                                // 클래스명 패턴 매칭
                                '[class*="title_name"]',
                                '[class*="product_name"]',
                                '[class*="productName"]',
                                
                                // 기존 셀렉터
                                '.goodsDetailInfo_title_name_unity',
                                '[class*="title_name_unity"]',
                                
                                // 최후의 수단
                                'h1',
                                'h2.prd_name',
                            ];
                            
                            for (const selector of titleSelectors) {
                                try {
                                    const el = document.querySelector(selector);
                                    if (el) {
                                        const text = el.textContent.trim();
                                        // 최소 5자 이상, 150자 이하
                                        if (text.length > 5 && text.length < 150) {
                                            result.rawTitle = text;
                                            break;
                                        }
                                    }
                                } catch (e) {
                                    // 셀렉터 오류 무시
                                }
                            }
                            
                            // ✅ 타이틀을 못 찾았으면 meta 태그에서 시도
                            if (!result.rawTitle) {
                                const ogTitle = document.querySelector('meta[property="og:title"]');
                                if (ogTitle && ogTitle.content) {
                                    result.rawTitle = ogTitle.content.trim();
                                }
                            }
                            
                            // ✅ 그래도 없으면 JSON-LD에서 시도
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
                            const priceEl = document.querySelector('[class*="price"]');
                            
                            if (priceEl) {
                                const priceText = priceEl.textContent;
                                const prices = priceText.match(/[\d,]+원/g);
                                
                                if (prices && prices.length >= 2) {
                                    result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                    result.priceDiscount = parseInt(prices[1].replace(/[^0-9]/g, ''));
                                } else if (prices && prices.length === 1) {
                                    result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                    result.priceDiscount = result.priceOriginal;
                                }
                            }
                            
                            if (result.priceOriginal && result.priceDiscount && 
                                result.priceOriginal < result.priceDiscount) {
                                const temp = result.priceOriginal;
                                result.priceOriginal = result.priceDiscount;
                                result.priceDiscount = temp;
                            }
                            
                            // ===== ✅ 수정: 이미지 수집 (우선순위 정렬) =====
                            const seenUrls = new Set();
                            const priorityImages = [];  // 높은 우선순위 (gdasEditor, display)
                            const fallbackImages = [];  // 낮은 우선순위 (cfimages - 404 위험)
                            
                            // 모든 이미지 태그 검색
                            const images = document.querySelectorAll('img');
                            
                            images.forEach(img => {
                                // ✅ 여러 속성에서 URL 추출 시도
                                let src = img.getAttribute('data-src') ||
                                          img.getAttribute('data-origin') ||
                                          img.getAttribute('data-lazy') ||
                                          img.getAttribute('data-original') ||
                                          img.src ||
                                          img.getAttribute('src');
                                
                                if (!src) return;
                                
                                // oliveyoung.co.kr 이미지만
                                if (!src.includes('oliveyoung.co.kr')) return;
                                
                                // 프로토콜 추가
                                if (src.startsWith('//')) {
                                    src = 'https:' + src;
                                }
                                
                                // 썸네일 → 원본 변환
                                src = src.replace('/thumbnails/', '/');
                                
                                // 제외할 패턴
                                if (seenUrls.has(src)) return;
                                if (src.includes('/icon/')) return;
                                if (src.includes('/badge/')) return;
                                if (src.includes('/banner/')) return;
                                if (src.includes('/event/')) return;
                                if (src.includes('/logo/')) return;
                                if (src.includes('/btn/')) return;
                                if (src.includes('/common/')) return;
                                if (src.includes('120x120')) return;
                                if (src.includes('80x80')) return;
                                if (src.includes('60x60')) return;
                                if (src.includes('40x40')) return;
                                
                                seenUrls.add(src);
                                
                                // ✅ 우선순위 분류 (404가 안 나는 경로 우선!)
                                if (src.includes('/gdasEditor/') || src.includes('/display/')) {
                                    // 상세 설명 이미지, 디스플레이 이미지 → 높은 우선순위
                                    priorityImages.push(src);
                                } else if (src.includes('/cfimages/cf-goods/uploads/images/')) {
                                    // 메인 갤러리 썸네일 → 낮은 우선순위 (404 위험)
                                    fallbackImages.push(src);
                                } else if (src.includes('/item/')) {
                                    // 아이템 이미지 → 중간 우선순위
                                    priorityImages.push(src);
                                } else {
                                    // 기타
                                    fallbackImages.push(src);
                                }
                            });
                            
                            // ✅ 우선순위 이미지 먼저, 그 다음 fallback
                            result.imageUrls = [...priorityImages, ...fallbackImages].slice(0, 40);
                            
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
                            
                            // 테이블이 아닌 경우 div 구조에서도 추출 시도
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
                        log(`   이미지: ${productData.imageUrls.length}개`);
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
                            
                            log(`📝 타이틀 클리닝:`);
                            log(`   원본: "${productData.rawTitle.substring(0, 60)}"`);
                            log(`   정제: "${cleanedTitle}"`);
                            
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
                            log(`🖼️  이미지 처리 중...`);
                            
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
        
        await crawler.run(requests);
        
        await crawler.teardown();
        await forceGarbageCollection();
        
        // 최종 결과
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
        log(`   - images 404: ${stats.images404Skipped}개 스킵`);
        log(`   - images 다운로드 실패: ${stats.imagesDownloadFailed}개`);
        
        logMemoryUsage('최종');
        
        log(`📁 로그 파일: ${LOG_PATH}`);
        log(`💡 다음 단계: Phase 2 실행`);
        log(`   node phase2-ai-generate.js`);
        
    } catch (error) {
        log('❌ 치명적 오류:', error.message);
        log(error.stack);
    } finally {
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