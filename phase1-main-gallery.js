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
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
    imagesFilled: 0,
    titleKrSkipped: 0,
    titleEnSkipped: 0,
    priceSkipped: 0,
    imagesSkipped: 0
};

// ==================== 필드 체크 함수 ====================
function checkMissingFields(product) {
    const missing = {
        needsTitleKr: !product.title_kr || product.title_kr.trim() === '',
        needsTitleEn: !product.title_en || product.title_en.trim() === '',
        needsPriceOriginal: !product.price_original || product.price_original === 0,
        needsPriceDiscount: !product.price_discount || product.price_discount === 0,
        needsImages: !product.product_images || product.product_images.length === 0
    };
    
    // 페이지 방문이 필요한지 (타이틀이나 가격이 없으면 방문 필요)
    missing.needsPageVisit = missing.needsTitleKr || missing.needsPriceOriginal;
    
    // 아무것도 필요 없으면 완전 스킵
    missing.isComplete = !missing.needsTitleKr && !missing.needsTitleEn && 
                         !missing.needsPriceOriginal && !missing.needsImages;
    
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
        '출시'
    ];
    
    // 키워드 제거 (대소문자 무시, 단어 끝에 있는 것 우선)
    for (const keyword of removeKeywords) {
        const endRegex = new RegExp(`\\s*${keyword}\\s*$`, 'gi');
        cleaned = cleaned.replace(endRegex, '');
        
        const midRegex = new RegExp(`\\s*${keyword}\\s*`, 'gi');
        cleaned = cleaned.replace(midRegex, ' ');
    }
    
    // 3단계: 증정 관련 패턴 제거
    cleaned = cleaned.replace(/\+\s*\d+\s*(개|매|입|팩|장|ml|g|ea)?\s*(증정|기획|추가)?/gi, '');
    cleaned = cleaned.replace(/\d+\s*\+\s*\d+\s*(증정|기획)?/gi, '');
    
    // 4단계: 정리
    cleaned = cleaned.replace(/\s+/g, ' ');
    cleaned = cleaned.trim();
    cleaned = cleaned.replace(/[\s,\-_\/\\·]+$/g, '');
    cleaned = cleaned.replace(/^[\s,\-_\/\\·]+/g, '');
    
    return cleaned;
}

// ==================== 영어 번역 함수 (OpenAI GPT-4o-mini) ====================
async function translateToEnglish(koreanTitle) {
    if (!koreanTitle || !OPENAI_API_KEY) {
        console.log('   ⚠️  번역 건너뜀 (타이틀 없음 또는 API 키 없음)');
        return null;
    }
    
    try {
        console.log(`   🌐 영어 번역 중...`);
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a Korean to English translator specializing in Korean cosmetics/beauty products.

Rules:
1. Translate product names accurately
2. Keep Korean brand names in romanized form:
   - 아벤느 → Avene
   - 라운드랩 → Round Lab  
   - 토리든 → Torriden
   - 달바 → d'Alba
   - 메디힐 → Mediheal
   - 닥터지 → Dr.G
   - 이니스프리 → Innisfree
   - 에뛰드 → Etude
   - 미샤 → Missha
   - 스킨푸드 → Skinfood
   - 코스알엑스 → COSRX
   - 넘버즈인 → Numbuzin
   - 아누아 → Anua
   - VT → VT (keep as is)
3. Translate product types:
   - 미스트 → Mist
   - 토너 → Toner
   - 세럼 → Serum
   - 크림 → Cream
   - 에센스 → Essence
   - 마스크 → Mask
   - 클렌저 → Cleanser
   - 선크림/선블록 → Sunscreen
   - 로션 → Lotion
   - 앰플 → Ampoule
4. Keep measurements as-is: 300ml, 50g, etc.
5. Keep numbers for sets: 2입 → Set of 2, 4매 → 4 Sheets
6. Output ONLY the translated title, nothing else`
                },
                {
                    role: 'user',
                    content: koreanTitle
                }
            ],
            max_tokens: 200,
            temperature: 0.3
        });
        
        const translated = response.choices[0].message.content.trim();
        console.log(`   ✅ 번역 완료: "${translated}"`);
        
        return translated;
        
    } catch (error) {
        console.error(`   ❌ 번역 실패:`, error.message);
        return null;
    }
}

// ==================== NocoDB: 제품 가져오기 (수정됨) ====================
async function getOliveyoungProducts(limit = 100, offset = 0) {
    try {
        console.log(`📥 NocoDB에서 제품 가져오는 중 (offset: ${offset}, limit: ${limit})...`);
        
        // ✅ 하나라도 빈 필드가 있는 제품 가져오기
        // NocoDB에서 OR 조건 사용: title_kr이 없거나 price_original이 없거나 product_images가 없는 제품
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    offset: offset,
                    limit: limit,
                    where: '~or((title_kr,isnull)~or(title_kr,eq,),(price_original,isnull)~or(price_original,eq,0),(product_images,isnull))'
                }
            }
        );

        const products = response.data.list;
        console.log(`✅ ${products.length}개 제품 가져옴 (빈 필드 있는 제품)\n`);
        
        // 각 제품의 빈 필드 현황 출력
        let needsTitle = 0, needsPrice = 0, needsImages = 0;
        for (const p of products) {
            const missing = checkMissingFields(p);
            if (missing.needsTitleKr) needsTitle++;
            if (missing.needsPriceOriginal) needsPrice++;
            if (missing.needsImages) needsImages++;
        }
        
        console.log(`📊 빈 필드 현황:`);
        console.log(`   - title_kr 필요: ${needsTitle}개`);
        console.log(`   - price_original 필요: ${needsPrice}개`);
        console.log(`   - product_images 필요: ${needsImages}개\n`);
        
        return products;

    } catch (error) {
        console.error('❌ 제품 가져오기 실패:', error.response?.data || error.message);
        
        // ✅ 폴백: where 조건 실패 시 모든 제품 가져온 후 필터링
        console.log('⚠️  폴백 모드: 모든 제품 가져온 후 필터링...');
        
        try {
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
            
            // 빈 필드가 있는 제품만 필터링
            const products = response.data.list.filter(p => {
                const missing = checkMissingFields(p);
                return !missing.isComplete;
            });
            
            console.log(`✅ ${products.length}개 제품 필터링됨 (빈 필드 있는 제품)\n`);
            return products;
            
        } catch (fallbackError) {
            console.error('❌ 폴백도 실패:', fallbackError.message);
            return [];
        }
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

// ==================== NocoDB: 제품 업데이트 ====================
async function updateProduct(recordId, updateData) {
    try {
        console.log(`\n📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        
        // 이미지가 있는 경우 2단계 업데이트 (기존 삭제 → 새로 저장)
        if (updateData.product_images) {
            console.log(`🗑️  기존 product_images 삭제 중...`);
            await axios.patch(
                `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
                [{ 
                    Id: recordId, 
                    product_images: null
                }],
                { 
                    headers: { 
                        'xc-token': NOCODB_TOKEN,
                        'Content-Type': 'application/json'
                    } 
                }
            );
        }
        
        // 새 데이터 저장
        console.log(`💾 새 데이터 저장 중...`);
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [{ 
                Id: recordId, 
                ...updateData
            }],
            { 
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        console.log(`✅ 제품 레코드 업데이트 완료!\n`);
        return true;

    } catch (error) {
        console.error('❌ 업데이트 실패:', error.response?.data || error.message);
        return false;
    }
}

// ==================== 단일 제품 처리 (수정됨: 필드별 체크) ====================
async function processProduct(product, galleryImages, productData, missingFields) {
    try {
        const updateData = {
            scraped_at: new Date().toISOString()
        };
        
        let hasUpdates = false;
        
        // ✅ 1. 타이틀 처리 (title_kr이 없을 때만)
        if (missingFields.needsTitleKr && productData.rawTitle) {
            const cleanedTitle = cleanProductTitle(productData.rawTitle);
            updateData.title_kr = cleanedTitle;
            hasUpdates = true;
            stats.titleKrFilled++;
            
            console.log(`\n📝 타이틀 클리닝:`);
            console.log(`   원본: "${productData.rawTitle}"`);
            console.log(`   정제: "${cleanedTitle}"`);
            
            // title_en도 없으면 번역 (새로 추출한 title_kr로)
            if (missingFields.needsTitleEn) {
                const englishTitle = await translateToEnglish(cleanedTitle);
                if (englishTitle) {
                    updateData.title_en = englishTitle;
                    stats.titleEnFilled++;
                }
            } else {
                console.log(`   ℹ️  title_en 이미 있음 → 번역 스킵`);
                stats.titleEnSkipped++;
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
            } else {
                stats.titleEnSkipped++;
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
            
            if (updateData.price_discount < updateData.price_original) {
                const discountRate = Math.round((1 - updateData.price_discount / updateData.price_original) * 100);
                console.log(`   할인율: ${discountRate}%`);
            }
        } else if (!missingFields.needsPriceOriginal) {
            console.log(`\n💰 가격: 이미 있음 → 스킵`);
            stats.priceSkipped++;
        }
        
        // ✅ 3. 이미지 처리 (product_images가 없을 때만)
        if (missingFields.needsImages) {
            if (galleryImages.length === 0) {
                console.log('\n⚠️  메인 갤러리 이미지를 찾을 수 없습니다.');
            } else {
                console.log(`\n📊 이미지: ${galleryImages.length}개 발견`);
                
                const maxImages = Math.min(galleryImages.length, 7);
                console.log(`📥 ${maxImages}개 이미지 다운로드 & 업로드 중...`);
                
                const uploadedFiles = [];
                
                for (let i = 0; i < maxImages; i++) {
                    const img = galleryImages[i];
                    console.log(`\n[${i + 1}/${maxImages}] ${img.src.substring(0, 60)}...`);
                    
                    const buffer = await downloadImage(img.src);
                    if (!buffer) continue;
                    
                    const filename = `gallery-${product.Id}-${i + 1}-${Date.now()}.jpg`;
                    const uploadResult = await uploadToNocoDB(buffer, filename);
                    
                    if (uploadResult) {
                        uploadedFiles.push(uploadResult);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                if (uploadedFiles.length > 0) {
                    updateData.product_images = uploadedFiles.map((file, index) => {
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
                    
                    hasUpdates = true;
                    stats.imagesFilled++;
                    console.log(`\n✅ ${uploadedFiles.length}개 이미지 업로드 완료`);
                }
            }
        } else {
            console.log(`\n🖼️  이미지: 이미 있음 → 스킵 (시간 절약!)`);
            stats.imagesSkipped++;
        }
        
        // ✅ 4. DB 업데이트 (변경사항이 있을 때만)
        if (hasUpdates) {
            const updateSuccess = await updateProduct(product.Id, updateData);
            return updateSuccess;
        } else {
            console.log(`\nℹ️  업데이트할 내용 없음`);
            return true;
        }
        
    } catch (error) {
        console.error(`\n❌ 처리 중 오류:`, error.message);
        return false;
    }
}

// ==================== 메인 ====================
async function main() {
    console.log('='.repeat(70) + '\n');
    
    try {
        // 1. NocoDB에서 제품 가져오기 (빈 필드 있는 제품만)
        const limit = parseInt(process.env.PRODUCT_LIMIT) || 100;
        const products = await getOliveyoungProducts(limit, 0);
        
        if (products.length === 0) {
            console.log('⚠️  처리할 제품이 없습니다.');
            console.log('   (모든 필드가 채워진 상태)');
            return;
        }
        
        // ✅ 페이지 방문이 필요한 제품과 아닌 제품 분리
        const needsPageVisit = [];
        const onlyNeedsTranslation = [];
        
        for (const product of products) {
            const missing = checkMissingFields(product);
            
            if (missing.needsPageVisit || missing.needsImages) {
                // 타이틀, 가격, 이미지 중 하나라도 없으면 페이지 방문 필요
                needsPageVisit.push({ product, missing });
            } else if (missing.needsTitleEn && product.title_kr) {
                // title_kr은 있는데 title_en만 없는 경우 → 페이지 방문 없이 번역만
                onlyNeedsTranslation.push({ product, missing });
            }
        }
        
        console.log(`📋 처리 계획:`);
        console.log(`   - 페이지 방문 필요: ${needsPageVisit.length}개`);
        console.log(`   - 번역만 필요: ${onlyNeedsTranslation.length}개\n`);
        
        // ✅ 번역만 필요한 제품 먼저 처리 (페이지 방문 없이)
        if (onlyNeedsTranslation.length > 0) {
            console.log('='.repeat(70));
            console.log('📚 번역만 필요한 제품 처리 중...');
            console.log('='.repeat(70) + '\n');
            
            for (let i = 0; i < onlyNeedsTranslation.length; i++) {
                const { product, missing } = onlyNeedsTranslation[i];
                
                console.log(`\n[${i + 1}/${onlyNeedsTranslation.length}] 제품 ID: ${product.Id}`);
                console.log(`   title_kr: "${product.title_kr}"`);
                
                const englishTitle = await translateToEnglish(product.title_kr);
                
                if (englishTitle) {
                    await updateProduct(product.Id, {
                        title_en: englishTitle,
                        scraped_at: new Date().toISOString()
                    });
                    stats.titleEnFilled++;
                    successCount++;
                } else {
                    failedCount++;
                }
                
                processedCount++;
            }
        }
        
        // ✅ 페이지 방문이 필요한 제품 처리
        if (needsPageVisit.length > 0) {
            console.log('\n' + '='.repeat(70));
            console.log('🌐 페이지 방문이 필요한 제품 처리 중...');
            console.log('='.repeat(70) + '\n');
            
            const totalProducts = needsPageVisit.length;
            
            // Crawlee 설정
            const crawler = new PlaywrightCrawler({
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
                
                requestHandler: async ({ page, request }) => {
                    const { product, missing } = request.userData;
                    const index = request.userData.index;
                    
                    console.log(`\n${'='.repeat(70)}`);
                    console.log(`📦 [${index + 1}/${totalProducts}] 제품 ID: ${product.Id}`);
                    console.log(`🔗 URL: ${request.url.substring(0, 80)}...`);
                    console.log('─'.repeat(70));
                    console.log(`📋 필요한 필드:`);
                    console.log(`   - title_kr: ${missing.needsTitleKr ? '❌ 필요' : '✅ 있음'}`);
                    console.log(`   - title_en: ${missing.needsTitleEn ? '❌ 필요' : '✅ 있음'}`);
                    console.log(`   - price: ${missing.needsPriceOriginal ? '❌ 필요' : '✅ 있음'}`);
                    console.log(`   - images: ${missing.needsImages ? '❌ 필요' : '✅ 있음'}`);
                    console.log('='.repeat(70));
                    
                    try {
                        await page.waitForLoadState('networkidle', { timeout: 30000 });
                        await page.waitForTimeout(3000);
                        
                        // ==================== 제품 정보 추출 ====================
                        const productData = await page.evaluate((needsTitle, needsPrice) => {
                            const result = {
                                rawTitle: null,
                                priceOriginal: null,
                                priceDiscount: null
                            };
                            
                            // 타이틀이 필요할 때만 추출
                            if (needsTitle) {
                                const titleSelectors = [
                                    '.prd_name',
                                    '.goods_name',
                                    '.product-name',
                                    'h1.name',
                                    '[class*="prdName"]',
                                    '[class*="goodsName"]',
                                    '.pdp_prd_name'
                                ];
                                
                                for (const selector of titleSelectors) {
                                    const titleEl = document.querySelector(selector);
                                    if (titleEl && titleEl.textContent.trim()) {
                                        result.rawTitle = titleEl.textContent.trim();
                                        break;
                                    }
                                }
                            }
                            
                            // 가격이 필요할 때만 추출
                            if (needsPrice) {
                                // 정가 추출
                                const originalPriceSelectors = [
                                    '.price-1 span',
                                    '.org_price',
                                    '.original_price',
                                    '.origin-price',
                                    '[class*="orgPrice"]',
                                    '[class*="originalPrice"]'
                                ];
                                
                                for (const selector of originalPriceSelectors) {
                                    const priceEl = document.querySelector(selector);
                                    if (priceEl) {
                                        const priceText = priceEl.textContent.trim();
                                        const priceNum = parseInt(priceText.replace(/[^0-9]/g, ''));
                                        if (priceNum > 0) {
                                            result.priceOriginal = priceNum;
                                            break;
                                        }
                                    }
                                }
                                
                                // 할인가 추출
                                const discountPriceSelectors = [
                                    '.price-2 span',
                                    '.sale_price',
                                    '.final-price',
                                    '.discount-price',
                                    '[class*="salePrice"]',
                                    '[class*="finalPrice"]',
                                    '[class*="discountPrice"]'
                                ];
                                
                                for (const selector of discountPriceSelectors) {
                                    const priceEl = document.querySelector(selector);
                                    if (priceEl) {
                                        const priceText = priceEl.textContent.trim();
                                        const priceNum = parseInt(priceText.replace(/[^0-9]/g, ''));
                                        if (priceNum > 0) {
                                            result.priceDiscount = priceNum;
                                            break;
                                        }
                                    }
                                }
                                
                                // 정가를 못 찾았는데 할인가는 있는 경우
                                if (!result.priceOriginal && result.priceDiscount) {
                                    result.priceOriginal = result.priceDiscount;
                                    result.priceDiscount = null;
                                }
                                
                                // 폴백
                                if (!result.priceOriginal) {
                                    const fallbackSelectors = [
                                        '.prd_price .tx_num',
                                        '.price_box .price',
                                        '.prd_price .price'
                                    ];
                                    
                                    for (const selector of fallbackSelectors) {
                                        const priceEl = document.querySelector(selector);
                                        if (priceEl) {
                                            const priceText = priceEl.textContent.trim();
                                            const priceNum = parseInt(priceText.replace(/[^0-9]/g, ''));
                                            if (priceNum > 0) {
                                                result.priceOriginal = priceNum;
                                                break;
                                            }
                                        }
                                    }
                                }
                                
                                // 할인가가 정가보다 큰 경우 스왑
                                if (result.priceOriginal && result.priceDiscount && 
                                    result.priceDiscount > result.priceOriginal) {
                                    const temp = result.priceOriginal;
                                    result.priceOriginal = result.priceDiscount;
                                    result.priceDiscount = temp;
                                }
                            }
                            
                            return result;
                        }, missing.needsTitleKr, missing.needsPriceOriginal);
                        
                        console.log(`\n📋 추출된 정보:`);
                        if (missing.needsTitleKr) {
                            console.log(`   타이틀: ${productData.rawTitle || '없음'}`);
                        }
                        if (missing.needsPriceOriginal) {
                            console.log(`   정가: ${productData.priceOriginal ? '₩' + productData.priceOriginal.toLocaleString() : '없음'}`);
                            console.log(`   할인가: ${productData.priceDiscount ? '₩' + productData.priceDiscount.toLocaleString() : '없음'}`);
                        }
                        
                        // ==================== 이미지 추출 (필요할 때만) ====================
                        let galleryImages = [];
                        
                        if (missing.needsImages) {
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
                                        
                                        results.push({
                                            method: `CSS: ${selector}`,
                                            images: filteredImages
                                        });
                                        break;
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
                            
                            if (images.length > 0) {
                                const result = images[0];
                                console.log(`\n✅ 이미지 추출: ${result.method}`);
                                
                                galleryImages = result.images.filter(img => 
                                    img.src.includes('oliveyoung.co.kr') ||
                                    img.src.includes('image.oliveyoung')
                                );
                                
                                console.log(`   올리브영 이미지: ${galleryImages.length}개`);
                            }
                        }
                        
                        // ==================== 제품 처리 ====================
                        const success = await processProduct(product, galleryImages, productData, missing);
                        
                        if (success) {
                            successCount++;
                        } else {
                            failedCount++;
                        }
                        
                        processedCount++;
                        
                    } catch (pageError) {
                        console.error('⚠️  페이지 처리 오류:', pageError.message);
                        failedCount++;
                        processedCount++;
                    }
                },
                
                maxRequestsPerCrawl: 1000,
                maxConcurrency: 1,
                requestHandlerTimeoutSecs: 180
            });
            
            // URL 요청 생성
            const requests = needsPageVisit.map(({ product, missing }, index) => ({
                url: product.product_url,
                userData: {
                    product: product,
                    missing: missing,
                    index: index
                }
            }));
            
            console.log(`🌐 Crawler 시작 - ${needsPageVisit.length}개 제품 처리\n`);
            
            await crawler.run(requests);
            
            // ✅ 크롤러 정리 (좀비 프로세스 방지)
            await crawler.teardown();
        }
        
        // 최종 결과
        console.log('\n' + '='.repeat(70));
        console.log('🎉 Phase 1 완료!');
        console.log('='.repeat(70));
        console.log(`\n📊 처리 결과:`);
        console.log(`   ✅ 성공: ${successCount}개`);
        console.log(`   ❌ 실패: ${failedCount}개`);
        console.log(`   ⏭️  스킵: ${skippedCount}개`);
        
        console.log(`\n📈 필드별 통계:`);
        console.log(`   title_kr: ${stats.titleKrFilled}개 채움, ${stats.titleKrSkipped}개 스킵`);
        console.log(`   title_en: ${stats.titleEnFilled}개 채움, ${stats.titleEnSkipped}개 스킵`);
        console.log(`   price: ${stats.priceFilled}개 채움, ${stats.priceSkipped}개 스킵`);
        console.log(`   images: ${stats.imagesFilled}개 채움, ${stats.imagesSkipped}개 스킵`);
        
        console.log(`\n💡 다음 단계: node phase2-ai-generate.js`);
        
    } catch (error) {
        console.error('\n❌ 치명적 오류:', error.message);
        console.error(error.stack);
    }
}

main();