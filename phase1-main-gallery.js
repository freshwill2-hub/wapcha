import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';
import FormData from 'form-data';
import OpenAI from 'openai';

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID || 'mufuxqsjgqcvh80';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// OpenAI 클라이언트
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log('🚀 Phase 1: 제품 상세 스크래핑 (스마트 필드별 체크)');
console.log('='.repeat(70));
console.log('🔧 설정 확인:');
console.log(`- NocoDB URL: ${NOCODB_API_URL}`);
console.log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);
console.log(`- OpenAI API: ${OPENAI_API_KEY ? '✅ 설정됨' : '❌ 없음'}`);
console.log('\n📋 스마트 필드 체크 모드:');
console.log('   - 각 필드별로 개별 체크');
console.log('   - 빈 필드만 채우고, 있는 필드는 스킵');
console.log('   - 이미지 있으면 이미지 다운로드 스킵 (시간 절약)\n');

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
        console.log('   ⚠️  번역 스킵: OpenAI API 키 없음 또는 텍스트 없음');
        return null;
    }
    
    try {
        console.log(`   🌐 번역 중: "${koreanText.substring(0, 50)}..."`);
        
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
        console.log(`   ✅ 번역 완료: "${translatedText}"`);
        
        return translatedText;
        
    } catch (error) {
        console.error(`   ❌ 번역 실패: ${error.message}`);
        return null;
    }
}

// ==================== 설명 번역 함수 ====================
async function translateDescriptionToEnglish(koreanDescription) {
    if (!openai || !koreanDescription) {
        return null;
    }
    
    try {
        console.log(`   🌐 설명 번역 중...`);
        
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
        console.log(`   ✅ 설명 번역 완료 (${translatedText.length}자)`);
        
        return translatedText;
        
    } catch (error) {
        console.error(`   ❌ 설명 번역 실패: ${error.message}`);
        return null;
    }
}

// ==================== NocoDB: 제품 가져오기 ====================
async function getOliveyoungProducts(limit = 100, offset = 0) {
    try {
        console.log(`📥 NocoDB에서 제품 가져오는 중 (offset: ${offset}, limit: ${limit})...`);
        
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
        console.log(`✅ ${products.length}개 제품 가져옴`);
        
        // 빈 필드 통계
        let needsTitle = 0, needsPrice = 0, needsDescription = 0, needsImages = 0;
        for (const p of products) {
            const missing = checkMissingFields(p);
            if (missing.needsTitleKr) needsTitle++;
            if (missing.needsPriceOriginal) needsPrice++;
            if (missing.needsDescription) needsDescription++;
            if (missing.needsImages) needsImages++;
        }
        
        console.log(`📊 빈 필드 현황:`);
        console.log(`   - title_kr 필요: ${needsTitle}개`);
        console.log(`   - price_original 필요: ${needsPrice}개`);
        console.log(`   - description 필요: ${needsDescription}개`);
        console.log(`   - product_images 필요: ${needsImages}개\n`);
        
        return products;

    } catch (error) {
        console.error('❌ 제품 가져오기 실패:', error.response?.data || error.message);
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
        console.log(`   📥 다운로드 완료 (${sizeMB} MB)`);
        
        return buffer;

    } catch (error) {
        console.error(`   ❌ 다운로드 실패: ${error.message}`);
        return null;
    }
}

// ==================== NocoDB: 파일 업로드 ====================
async function uploadToNocoDB(fileBuffer, filename) {
    try {
        console.log(`   📤 NocoDB 업로드: ${filename}`);
        
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

        console.log(`   ✅ 업로드 성공`);
        
        const uploadData = Array.isArray(response.data) ? response.data[0] : response.data;
        return uploadData;

    } catch (error) {
        console.error(`   ❌ 업로드 실패:`, error.response?.data || error.message);
        return null;
    }
}

// ==================== NocoDB: 제품 업데이트 (통합) ====================
async function updateProduct(recordId, updateData) {
    try {
        console.log(`\n📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        
        // 업데이트할 필드들 로그
        const fields = Object.keys(updateData).filter(k => k !== 'Id');
        console.log(`📋 업데이트 필드: ${fields.join(', ')}`);
        
        // product_images가 있으면 2단계 처리 (기존 삭제 후 저장)
        if (updateData.product_images) {
            // 1단계: 기존 이미지 삭제
            console.log(`🗑️  기존 product_images 삭제 중...`);
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
        
        console.log(`✅ 제품 레코드 업데이트 완료! (시간: ${scrapedAt})\n`);
        return true;

    } catch (error) {
        console.error('❌ 업데이트 실패:', error.response?.data || error.message);
        return false;
    }
}

// ==================== 이미지 처리 (다운로드 & 업로드) ====================
async function processProductImages(product, galleryImages) {
    try {
        if (galleryImages.length === 0) {
            console.log('❌ 메인 갤러리 이미지를 찾을 수 없습니다.\n');
            return [];
        }
        
        console.log(`📊 추출된 이미지: ${galleryImages.length}개`);
        galleryImages.slice(0, 5).forEach((img, i) => {
            console.log(`   ${i + 1}. ${img.src.substring(0, 70)}... (${img.width}×${img.height})`);
        });
        
        const maxImages = Math.min(galleryImages.length, 7);
        console.log(`\n📥 ${maxImages}개 이미지 다운로드 & 업로드 중...\n`);
        
        const uploadedFiles = [];
        
        for (let i = 0; i < maxImages; i++) {
            const img = galleryImages[i];
            console.log(`\n${i + 1}/${maxImages}: ${img.src.substring(0, 60)}...`);
            
            const buffer = await downloadImage(img.src);
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
        console.error(`\n❌ 이미지 처리 중 오류:`, error.message);
        return [];
    }
}

// ==================== 메인 ====================
async function main() {
    console.log('🚀 Phase 1: 메인 갤러리 이미지 + 타이틀/가격/설명 추출\n');
    console.log('=' .repeat(70) + '\n');
    
    let crawler = null;
    
    try {
        // 1. NocoDB에서 제품 가져오기
        const products = await getOliveyoungProducts(
            parseInt(process.env.PRODUCT_LIMIT) || 3, 
            0
        );
        
        if (products.length === 0) {
            console.log('⚠️  처리할 제품이 없습니다.');
            return;
        }
        
        // 페이지 방문이 필요한 제품만 필터링
        const productsToProcess = products.filter(p => {
            const missing = checkMissingFields(p);
            return missing.needsPageVisit;
        });
        
        console.log(`📋 페이지 방문 필요: ${productsToProcess.length}/${products.length}개\n`);
        
        if (productsToProcess.length === 0) {
            console.log('✅ 모든 제품이 이미 완전합니다. 처리할 것이 없습니다.');
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
                
                console.log(`\n${'='.repeat(70)}`);
                console.log(`📦 [${index + 1}/${totalProducts}] 제품 ID: ${product.Id}`);
                console.log(`🔗 URL: ${request.url.substring(0, 80)}...`);
                console.log(`📋 필요한 필드: ${[
                    missingFields.needsTitleKr ? 'title_kr' : null,
                    missingFields.needsPriceOriginal ? 'price' : null,
                    missingFields.needsDescription ? 'description' : null,
                    missingFields.needsImages ? 'images' : null
                ].filter(Boolean).join(', ')}`);
                console.log('='.repeat(70) + '\n');
                
                try {
                    // 페이지 로딩 (domcontentloaded 사용 - networkidle보다 안정적)
                    console.log(`📄 페이지 로딩 중...`);
                    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                    await page.waitForTimeout(3000);
                    
                    const updateData = {};
                    let hasUpdates = false;
                    
                    // ==================== 타이틀/가격/설명 추출 ====================
                    if (missingFields.needsTitleKr || missingFields.needsPriceOriginal || missingFields.needsDescription) {
                        console.log(`\n📊 웹페이지에서 정보 추출 중...`);
                        
                        const productData = await page.evaluate(() => {
                            const result = {
                                rawTitle: '',
                                priceOriginal: 0,
                                priceDiscount: 0,
                                description: ''
                            };
                            
                            // ===== 타이틀 추출 =====
                            const titleSelectors = [
                                '.prd_name',
                                '.goods_name', 
                                'h1[class*="name"]',
                                '.product-name',
                                'h1'
                            ];
                            
                            for (const selector of titleSelectors) {
                                const el = document.querySelector(selector);
                                if (el && el.textContent.trim().length > 5) {
                                    result.rawTitle = el.textContent.trim();
                                    break;
                                }
                            }
                            
                            // ===== 가격 추출 (할인가 = 현재가) =====
                            const discountPriceSelectors = [
                                '.price-2 strong',
                                '.tx_cur',
                                '.final-price',
                                '.sale_price',
                                '.prd-price strong',
                                '#finalPrc',
                                '.price_box .selling_price',
                                '.real-price strong',
                                '.discount-price strong',
                                '[class*="price"] strong'
                            ];
                            
                            for (const selector of discountPriceSelectors) {
                                const el = document.querySelector(selector);
                                if (el) {
                                    const text = el.textContent.replace(/[^0-9]/g, '');
                                    const num = parseInt(text);
                                    if (num > 0) {
                                        result.priceDiscount = num;
                                        break;
                                    }
                                }
                            }
                            
                            // ===== 가격 추출 (정가 = 원래가) =====
                            const originalPriceSelectors = [
                                '.price-1 strike',
                                '.tx_org',
                                '.original-price',
                                'del',
                                '[class*="org"]',
                                '.origin-price',
                                '.before-price'
                            ];
                            
                            for (const selector of originalPriceSelectors) {
                                const el = document.querySelector(selector);
                                if (el) {
                                    const text = el.textContent.replace(/[^0-9]/g, '');
                                    const num = parseInt(text);
                                    if (num > 0) {
                                        result.priceOriginal = num;
                                        break;
                                    }
                                }
                            }
                            
                            // 정가가 없으면 할인가를 정가로 사용
                            if (!result.priceOriginal && result.priceDiscount) {
                                result.priceOriginal = result.priceDiscount;
                            }
                            
                            // 할인가가 정가보다 크면 스왑
                            if (result.priceOriginal && result.priceDiscount && 
                                result.priceDiscount > result.priceOriginal) {
                                const temp = result.priceOriginal;
                                result.priceOriginal = result.priceDiscount;
                                result.priceDiscount = temp;
                            }
                            
                            // ===== 상세설명 추출 (상품정보 제공고시 테이블) =====
                            const infoTable = {
                                volume: '',
                                skinType: '',
                                expiry: '',
                                usage: '',
                                ingredients: ''
                            };
                            
                            // 상품정보 제공고시 테이블 찾기
                            const infoSection = document.querySelector('[class*="prd_detail_box"]') ||
                                               document.querySelector('[class*="product_info"]') ||
                                               document.querySelector('[class*="GoodsDetailInfo"]') ||
                                               document.querySelector('.info_table') ||
                                               document.querySelector('table');
                            
                            if (infoSection) {
                                const allRows = document.querySelectorAll('tr, dl, div[class*="row"], div[class*="item"]');
                                
                                const allowedKeywords = [
                                    '내용물', '용량', '중량', '주요 사양', 
                                    '사용기한', '개봉', '사용방법', '성분'
                                ];
                                
                                const blockKeywords = [
                                    '제조업자', '수입업자', '판매업자', '품질보증', 
                                    '소비자상담', '전화', '고객센터', '080', '1588', 
                                    '협력사', '본 상품 정보', '공정거래', '기능성',
                                    '맞춤형화장품판매업자', '㈜', '주식회사'
                                ];
                                
                                allRows.forEach(row => {
                                    const text = row.textContent || row.innerText || '';
                                    
                                    // 차단 키워드가 있으면 스킵
                                    if (blockKeywords.some(keyword => text.includes(keyword))) {
                                        return;
                                    }
                                    
                                    // 용량
                                    if ((text.includes('내용물') || text.includes('용량')) && !infoTable.volume) {
                                        const match = text.match(/([0-9]+\s*[mMlLgG]+.*?)(?=제품|사용|피부|$)/);
                                        if (match) {
                                            infoTable.volume = match[1].trim();
                                        }
                                    }
                                    
                                    // 피부 타입
                                    if (text.includes('주요 사양') && !infoTable.skinType) {
                                        const match = text.match(/주요\s*사양\s*(.+?)(?=사용|개봉|$)/);
                                        if (match) {
                                            infoTable.skinType = match[1].trim();
                                        }
                                    }
                                    
                                    // 사용기한
                                    if ((text.includes('사용기한') || text.includes('개봉')) && !infoTable.expiry) {
                                        const match = text.match(/(개봉\s*전.*?개월.*?개봉\s*후.*?개월)/);
                                        if (match) {
                                            infoTable.expiry = match[1].trim();
                                        }
                                    }
                                    
                                    // 사용방법
                                    if (text.includes('사용방법') && !infoTable.usage) {
                                        let usage = text.replace(/사용방법\s*/, '');
                                        // 불필요한 부분 제거
                                        usage = usage.split(/화장품제조업자|화장품책임판매업자|맞춤형화장품|제조업자|판매업자|㈜|주식회사/)[0];
                                        usage = usage.trim();
                                        if (usage.length > 10 && usage.length < 500) {
                                            infoTable.usage = usage;
                                        }
                                    }
                                    
                                    // 전체 성분
                                    if ((text.includes('모든 성분') || text.includes('전성분')) && !infoTable.ingredients) {
                                        const match = text.match(/(?:모든\s*성분|전성분)\s*(.+?)(?=화장품제조업자|기능성|품질|$)/s);
                                        if (match) {
                                            let ingredients = match[1]
                                                .replace(/화장품제조업자.*$/g, '')
                                                .replace(/제조업자.*$/g, '')
                                                .trim();
                                            
                                            if (ingredients.length > 20) {
                                                infoTable.ingredients = ingredients.substring(0, 500);
                                            }
                                        }
                                    }
                                });
                            }
                            
                            // 상세설명 조합 (타이틀 기반 용량 우선!)
                            const descParts = [];
                            
                            // ✅ 타이틀에서 용량 추출 (우선 적용)
                            let volumeFromTitle = null;
                            if (result.rawTitle) {
                                const volumes = [];
                                const volumePattern = /(\d+)\s*(ml|mL|ML|g|G)/gi;
                                let volMatch;
                                while ((volMatch = volumePattern.exec(result.rawTitle)) !== null) {
                                    volumes.push(volMatch[1] + volMatch[2].toLowerCase());
                                }
                                
                                // "2개", "2입", "2매" 등 개수 확인
                                const countMatch = result.rawTitle.match(/(\d+)\s*(개|입|매)/);
                                
                                if (countMatch && volumes.length > 0) {
                                    const count = parseInt(countMatch[1]);
                                    if (count > 1) {
                                        volumeFromTitle = `${volumes[0]} × ${count}`;
                                    }
                                }
                                
                                // 개수 없이 용량만 있는 경우
                                if (!volumeFromTitle && volumes.length > 1) {
                                    volumeFromTitle = volumes.join(' + ');
                                } else if (!volumeFromTitle && volumes.length === 1) {
                                    volumeFromTitle = volumes[0];
                                }
                            }
                            
                            // 용량: 타이틀 기반 > 테이블 기반
                            if (volumeFromTitle) {
                                descParts.push(`용량: ${volumeFromTitle}`);
                            } else if (infoTable.volume) {
                                descParts.push(`용량: ${infoTable.volume}`);
                            }
                            
                            if (infoTable.skinType) descParts.push(`피부 타입: ${infoTable.skinType}`);
                            if (infoTable.expiry) descParts.push(`사용기한: ${infoTable.expiry}`);
                            if (infoTable.usage) descParts.push(`사용방법: ${infoTable.usage}`);
                            if (infoTable.ingredients) {
                                // 주요 성분 (처음 5개)
                                const ingredientList = infoTable.ingredients.split(',').map(i => i.trim());
                                const mainIngredients = ingredientList.slice(0, 5).join(', ');
                                descParts.push(`주요 성분: ${mainIngredients}`);
                            }
                            
                            result.description = descParts.join('\n');
                            
                            return result;
                        });
                        
                        console.log(`\n📋 추출된 정보:`);
                        console.log(`   타이틀: ${productData.rawTitle ? productData.rawTitle.substring(0, 50) + '...' : '없음'}`);
                        console.log(`   정가: ${productData.priceOriginal ? '₩' + productData.priceOriginal.toLocaleString() : '없음'}`);
                        console.log(`   할인가: ${productData.priceDiscount ? '₩' + productData.priceDiscount.toLocaleString() : '없음'}`);
                        console.log(`   설명: ${productData.description ? productData.description.substring(0, 50) + '...' : '없음'}`);
                        
                        // ✅ 1. 타이틀 처리 (title_kr이 없을 때만)
                        if (missingFields.needsTitleKr && productData.rawTitle) {
                            const cleanedTitle = cleanProductTitle(productData.rawTitle);
                            updateData.title_kr = cleanedTitle;
                            hasUpdates = true;
                            stats.titleKrFilled++;
                            
                            console.log(`\n📝 타이틀 클리닝:`);
                            console.log(`   원본: "${productData.rawTitle}"`);
                            console.log(`   정제: "${cleanedTitle}"`);
                            
                            // title_en도 없으면 번역
                            if (missingFields.needsTitleEn) {
                                const englishTitle = await translateToEnglish(cleanedTitle);
                                if (englishTitle) {
                                    updateData.title_en = englishTitle;
                                    stats.titleEnFilled++;
                                }
                            }
                        } else if (!missingFields.needsTitleKr) {
                            console.log(`\n📝 타이틀: 이미 있음 → 스킵`);
                            stats.titleKrSkipped++;
                            
                            // title_kr은 있는데 title_en만 없는 경우
                            if (missingFields.needsTitleEn && product.title_kr) {
                                console.log(`   ℹ️  title_en 없음 → 기존 title_kr로 번역`);
                                const englishTitle = await translateToEnglish(product.title_kr);
                                if (englishTitle) {
                                    updateData.title_en = englishTitle;
                                    hasUpdates = true;
                                    stats.titleEnFilled++;
                                }
                            }
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
                            
                            console.log(`\n💰 가격:`);
                            console.log(`   정가 (price_original): ₩${updateData.price_original.toLocaleString()}`);
                            console.log(`   할인가 (price_discount): ₩${updateData.price_discount.toLocaleString()}`);
                        } else if (!missingFields.needsPriceOriginal) {
                            console.log(`\n💰 가격: 이미 있음 → 스킵`);
                            stats.priceSkipped++;
                        }
                        
                        // ✅ 3. 설명 처리 (description이 없을 때만)
                        if (missingFields.needsDescription && productData.description) {
                            updateData.description = productData.description;
                            hasUpdates = true;
                            stats.descriptionFilled++;
                            
                            console.log(`\n📄 설명: ${productData.description.substring(0, 50)}...`);
                            
                            // description_en도 없으면 번역
                            if (missingFields.needsDescriptionEn) {
                                const englishDesc = await translateDescriptionToEnglish(productData.description);
                                if (englishDesc) {
                                    updateData.description_en = englishDesc;
                                }
                            }
                        } else if (!missingFields.needsDescription) {
                            console.log(`\n📄 설명: 이미 있음 → 스킵`);
                            stats.descriptionSkipped++;
                        }
                    }
                    
                    // ==================== 이미지 추출 (필요할 때만) ====================
                    if (missingFields.needsImages) {
                        console.log(`\n🖼️  이미지 추출 중...`);
                        
                        const images = await page.evaluate(() => {
                            const results = [];
                            
                            const gallerySelectors = [
                                '.prd-detail-img img',
                                '.goods-img img',
                                '.detail-img img',
                                '.prd-img img',
                                '.swiper-slide img',
                                '.slider img',
                                '.gallery img',
                                '[class*="prdImg"] img',
                                '[class*="goodsImg"] img',
                                '[class*="detailImg"] img'
                            ];
                            
                            for (const selector of gallerySelectors) {
                                const imgs = Array.from(document.querySelectorAll(selector));
                                if (imgs.length > 0) {
                                    const filteredImages = imgs
                                        .map(img => ({
                                            src: img.src,
                                            width: img.naturalWidth || img.width,
                                            height: img.naturalHeight || img.height,
                                            alt: img.alt
                                        }))
                                        .filter(img => {
                                            if (img.width < 500 || img.height < 500) return false;
                                            const aspectRatio = img.width / img.height;
                                            if (aspectRatio > 2 || aspectRatio < 0.5) return false;
                                            if (img.src.includes('/display/')) return false;
                                            return true;
                                        });
                                    
                                    if (filteredImages.length > 0) {
                                        results.push({
                                            method: `CSS: ${selector}`,
                                            images: filteredImages
                                        });
                                        break;
                                    }
                                }
                            }
                            
                            // 폴백: 큰 이미지 찾기
                            if (results.length === 0) {
                                const allImages = Array.from(document.querySelectorAll('img'));
                                const largeImages = allImages.filter(img => {
                                    const width = img.naturalWidth || img.width;
                                    const height = img.naturalHeight || img.height;
                                    const rect = img.getBoundingClientRect();
                                    return width >= 500 && height >= 500 && rect.top < 1000;
                                });
                                
                                if (largeImages.length > 0) {
                                    results.push({
                                        method: 'Large images (top area)',
                                        images: largeImages.map(img => ({
                                            src: img.src,
                                            width: img.naturalWidth || img.width,
                                            height: img.naturalHeight || img.height,
                                            alt: img.alt
                                        }))
                                    });
                                }
                            }
                            
                            return results;
                        });
                        
                        let galleryImages = [];
                        
                        if (images.length > 0) {
                            const result = images[0];
                            console.log(`✅ 메인 갤러리 추출 성공: ${result.method}`);
                            console.log(`📸 ${result.images.length}개 이미지 발견`);
                            
                            galleryImages = result.images.filter(img => 
                                img.src.includes('oliveyoung.co.kr') ||
                                img.src.includes('image.oliveyoung')
                            );
                            
                            console.log(`✅ 올리브영 이미지만 필터링: ${galleryImages.length}개`);
                        } else {
                            console.log('⚠️  메인 갤러리를 찾을 수 없습니다.');
                        }
                        
                        // 이미지 다운로드 & 업로드
                        const attachments = await processProductImages(product, galleryImages);
                        
                        if (attachments.length > 0) {
                            updateData.product_images = attachments;
                            hasUpdates = true;
                            stats.imagesFilled++;
                            console.log(`✅ ${attachments.length}개 이미지 처리 완료`);
                        }
                    } else {
                        console.log(`\n🖼️  이미지: 이미 있음 → 스킵`);
                        stats.imagesSkipped++;
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
                        console.log(`\nℹ️  업데이트할 내용 없음`);
                        skippedCount++;
                    }
                    
                    processedCount++;
                    
                } catch (pageError) {
                    console.error('⚠️  페이지 처리 오류:', pageError.message);
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
        
        console.log(`🌐 Crawler 시작 - ${productsToProcess.length}개 제품 처리\n`);
        
        await crawler.run(requests);
        
        // ✅ Crawler 정리 (메모리 누수 방지)
        await crawler.teardown();
        
        // 4. 최종 결과
        console.log('\n' + '='.repeat(70));
        console.log('🎉 Phase 1 완료!');
        console.log('='.repeat(70));
        console.log(`✅ 성공: ${successCount}/${totalProducts}개 제품`);
        console.log(`⏭️  스킵: ${skippedCount}/${totalProducts}개 제품`);
        console.log(`❌ 실패: ${failedCount}/${totalProducts}개 제품`);
        
        console.log(`\n📊 필드별 통계:`);
        console.log(`   - title_kr: ${stats.titleKrFilled}개 채움, ${stats.titleKrSkipped}개 스킵`);
        console.log(`   - title_en: ${stats.titleEnFilled}개 채움, ${stats.titleEnSkipped}개 스킵`);
        console.log(`   - price: ${stats.priceFilled}개 채움, ${stats.priceSkipped}개 스킵`);
        console.log(`   - description: ${stats.descriptionFilled}개 채움, ${stats.descriptionSkipped}개 스킵`);
        console.log(`   - images: ${stats.imagesFilled}개 채움, ${stats.imagesSkipped}개 스킵`);
        
        console.log(`\n💡 다음 단계: Phase 2 실행`);
        console.log(`   node phase2-ai-generate.js`);
        
    } catch (error) {
        console.error('\n❌ 치명적 오류:', error.message);
        console.error(error.stack);
    } finally {
        // ✅ 크롤러 정리 확인
        if (crawler) {
            try {
                await crawler.teardown();
            } catch (e) {
                // 이미 종료됨
            }
        }
    }
}

main();