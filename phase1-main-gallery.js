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

console.log('🚀 Phase 1: 제품 상세 스크래핑 (이미지 + 타이틀 + 가격 + 번역)');
console.log('='.repeat(70));
console.log('🔧 설정 확인:');
console.log(`- NocoDB URL: ${NOCODB_API_URL}`);
console.log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);
console.log(`- OpenAI API: ${OPENAI_API_KEY ? '✅ 설정됨' : '❌ 없음'}\n`);

// ==================== 전역 변수 ====================
let processedCount = 0;
let successCount = 0;
let failedCount = 0;

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
        // 끝에 있는 키워드 제거 (예: "미스트 300ml 기획" → "미스트 300ml")
        const endRegex = new RegExp(`\\s*${keyword}\\s*$`, 'gi');
        cleaned = cleaned.replace(endRegex, '');
        
        // 중간에 있는 키워드도 제거
        const midRegex = new RegExp(`\\s*${keyword}\\s*`, 'gi');
        cleaned = cleaned.replace(midRegex, ' ');
    }
    
    // 3단계: 증정 관련 패턴 제거
    // "+숫자개 증정", "+숫자매 증정" 등
    cleaned = cleaned.replace(/\+\s*\d+\s*(개|매|입|팩|장|ml|g|ea)?\s*(증정|기획|추가)?/gi, '');
    
    // "숫자+숫자" 패턴 중 증정을 의미하는 것 (예: 2+1, 1+1)
    cleaned = cleaned.replace(/\d+\s*\+\s*\d+\s*(증정|기획)?/gi, '');
    
    // 4단계: 정리
    cleaned = cleaned.replace(/\s+/g, ' ');  // 연속 공백 → 단일 공백
    cleaned = cleaned.trim();
    
    // 끝에 남은 특수문자 정리
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
                    limit: limit,
                    where: '(product_images,isnull)'  // 아직 이미지가 없는 제품만
                }
            }
        );

        console.log(`✅ ${response.data.list.length}개 제품 가져옴 (이미지 미수집)\n`);
        return response.data.list;

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

// ==================== NocoDB: 제품 업데이트 ====================
async function updateProduct(recordId, updateData) {
    try {
        console.log(`\n📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        
        // 1단계: 기존 product_images 삭제 (이미지가 있는 경우)
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
        
        // 2단계: 새 데이터 저장
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

// ==================== 단일 제품 처리 ====================
async function processProduct(product, galleryImages, productData) {
    try {
        const updateData = {
            scraped_at: new Date().toISOString()
        };
        
        // 1. 타이틀 처리
        if (productData.rawTitle) {
            const cleanedTitle = cleanProductTitle(productData.rawTitle);
            updateData.title_kr = cleanedTitle;
            
            console.log(`\n📝 타이틀 클리닝:`);
            console.log(`   원본: "${productData.rawTitle}"`);
            console.log(`   정제: "${cleanedTitle}"`);
            
            // 영어 번역
            const englishTitle = await translateToEnglish(cleanedTitle);
            if (englishTitle) {
                updateData.title_en = englishTitle;
            }
        }
        
        // 2. 가격 처리
        if (productData.price) {
            updateData.price_original = productData.price;
            console.log(`\n💰 가격: ₩${productData.price.toLocaleString()}`);
        }
        
        // 3. 이미지 처리
        if (galleryImages.length === 0) {
            console.log('⚠️  메인 갤러리 이미지를 찾을 수 없습니다.');
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
                // attachment 형식으로 변환
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
                
                console.log(`\n✅ ${uploadedFiles.length}개 이미지 업로드 완료`);
            }
        }
        
        // 4. DB 업데이트
        const updateSuccess = await updateProduct(product.Id, updateData);
        
        return updateSuccess;
        
    } catch (error) {
        console.error(`\n❌ 처리 중 오류:`, error.message);
        return false;
    }
}

// ==================== 메인 ====================
async function main() {
    console.log('='.repeat(70) + '\n');
    
    try {
        // 1. NocoDB에서 제품 가져오기
        const limit = parseInt(process.env.PRODUCT_LIMIT) || 100;
        const products = await getOliveyoungProducts(limit, 0);
        
        if (products.length === 0) {
            console.log('⚠️  처리할 제품이 없습니다.');
            console.log('   (이미지가 없는 제품만 가져옵니다)');
            return;
        }
        
        const totalProducts = products.length;
        
        // 2. Crawlee 설정
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
                const product = request.userData.product;
                const index = request.userData.index;
                
                console.log(`\n${'='.repeat(70)}`);
                console.log(`📦 [${index + 1}/${totalProducts}] 제품 ID: ${product.Id}`);
                console.log(`🔗 URL: ${request.url.substring(0, 80)}...`);
                console.log('='.repeat(70));
                
                try {
                    await page.waitForLoadState('networkidle', { timeout: 30000 });
                    await page.waitForTimeout(3000);
                    
                    // ==================== 제품 정보 추출 ====================
                    const productData = await page.evaluate(() => {
                        const result = {
                            rawTitle: null,
                            price: null
                        };
                        
                        // 1. 타이틀 추출
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
                        
                        // 2. 가격 추출 (할인가 우선, 없으면 정가)
                        const priceSelectors = [
                            '.price-2 span',           // 할인가
                            '.price_box .price',
                            '.prd_price .price',
                            '.sale_price',
                            '.final-price',
                            '[class*="salePrice"]',
                            '[class*="finalPrice"]',
                            '.price-1 span',           // 정가
                            '.org_price',
                            '.original_price'
                        ];
                        
                        for (const selector of priceSelectors) {
                            const priceEl = document.querySelector(selector);
                            if (priceEl) {
                                const priceText = priceEl.textContent.trim();
                                // 숫자만 추출 (원, 콤마 제거)
                                const priceNum = parseInt(priceText.replace(/[^0-9]/g, ''));
                                if (priceNum > 0) {
                                    result.price = priceNum;
                                    break;
                                }
                            }
                        }
                        
                        return result;
                    });
                    
                    console.log(`\n📋 추출된 정보:`);
                    console.log(`   타이틀: ${productData.rawTitle || '없음'}`);
                    console.log(`   가격: ${productData.price ? '₩' + productData.price.toLocaleString() : '없음'}`);
                    
                    // ==================== 이미지 추출 ====================
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
                    
                    let galleryImages = [];
                    
                    if (images.length > 0) {
                        const result = images[0];
                        console.log(`\n✅ 이미지 추출: ${result.method}`);
                        
                        galleryImages = result.images.filter(img => 
                            img.src.includes('oliveyoung.co.kr') ||
                            img.src.includes('image.oliveyoung')
                        );
                        
                        console.log(`   올리브영 이미지: ${galleryImages.length}개`);
                    }
                    
                    // ==================== 제품 처리 ====================
                    const success = await processProduct(product, galleryImages, productData);
                    
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
        
        // 3. 모든 URL 전달
        const requests = products.map((product, index) => ({
            url: product.product_url,
            userData: {
                product: product,
                index: index
            }
        }));
        
        console.log(`🌐 Crawler 시작 - ${products.length}개 제품 처리\n`);
        
        await crawler.run(requests);
        
        // ✅ 크롤러 정리 (좀비 프로세스 방지)
        await crawler.teardown();
        
        // 4. 최종 결과
        console.log('\n' + '='.repeat(70));
        console.log('🎉 Phase 1 완료!');
        console.log('='.repeat(70));
        console.log(`✅ 성공: ${successCount}/${totalProducts}개 제품`);
        console.log(`❌ 실패: ${failedCount}/${totalProducts}개 제품`);
        console.log(`\n📊 저장된 데이터 (tb_oliveyoung_products):`);
        console.log(`   - title_kr: 한글 타이틀 (클리닝됨)`);
        console.log(`   - title_en: 영어 타이틀 (번역됨)`);
        console.log(`   - price_original: 원화 가격`);
        console.log(`   - product_images: 갤러리 이미지`);
        console.log(`   - scraped_at: 스크래핑 시간`);
        console.log(`\n💡 다음 단계: node phase2-ai-generate.js`);
        
    } catch (error) {
        console.error('\n❌ 치명적 오류:', error.message);
        console.error(error.stack);
    }
}

main();