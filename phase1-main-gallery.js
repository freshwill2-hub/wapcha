import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';
import FormData from 'form-data';

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID || 'mufuxqsjgqcvh80';

// 환경변수로 처리 개수 설정 가능
const PRODUCT_LIMIT = parseInt(process.env.PRODUCT_LIMIT) || parseInt(process.argv[2]) || 3;
const PRODUCT_OFFSET = parseInt(process.env.PRODUCT_OFFSET) || parseInt(process.argv[3]) || 0;

console.log('🔧 설정 확인:');
console.log(`- NocoDB URL: ${NOCODB_API_URL}`);
console.log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);
console.log(`- 처리 개수: ${PRODUCT_LIMIT}`);
console.log(`- 오프셋: ${PRODUCT_OFFSET}\n`);

// ==================== 전역 변수 ====================
let processedCount = 0;
let successCount = 0;
let failedCount = 0;

// ==================== NocoDB: 제품 가져오기 (✅ 수정됨: JS 필터링 방식) ====================
async function getOliveyoungProducts(limit = 100, offset = 0) {
    try {
        console.log(`📥 NocoDB에서 제품 가져오는 중...`);
        
        // ✅ 수정: where 조건 없이 가져온 후 JS에서 필터링
        // NocoDB가 isnull을 지원하지 않으므로 다른 방식 사용
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    offset: 0,
                    limit: 1000,  // 충분히 많이 가져와서 필터링
                    sort: '-Id'  // ✅ Id 기준 정렬 (최신 먼저)
                }
            }
        );

        let allProducts = response.data.list;
        console.log(`📊 전체 제품: ${allProducts.length}개`);
        
        // ✅ JS에서 scraped_at이 없는 제품만 필터링
        let products = allProducts.filter(p => !p.scraped_at);
        console.log(`🆕 미처리 제품 (scraped_at 없음): ${products.length}개`);
        
        // limit 적용
        products = products.slice(offset, offset + limit);
        console.log(`✅ 처리 대상: ${products.length}개 (offset: ${offset}, limit: ${limit})\n`);
        
        if (products.length === 0) {
            console.log('⚠️  스크래핑할 새 제품이 없습니다!');
            console.log('   → Phase 0을 먼저 실행하여 URL을 수집하세요.');
            console.log('   → 또는 NocoDB에서 scraped_at 필드를 비워주세요.\n');
        }

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

// ==================== NocoDB: 제품 업데이트 (정보 + 이미지) ====================
async function updateProduct(recordId, productInfo, uploadedFiles) {
    try {
        console.log(`\n📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        
        // 이미지 첨부 파일 포맷
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
        
        // ✅ scraped_at 저장 → 이 제품은 스크래핑 완료됨을 표시
        const scrapedAt = new Date().toISOString();
        
        // 1단계: 기존 이미지 삭제
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
        
        // 2단계: 제품 정보 + 이미지 저장
        console.log(`💾 제품 정보 + 이미지 저장 중...`);
        
        const updateData = { 
            Id: recordId,
            scraped_at: scrapedAt  // ✅ 핵심: 스크래핑 완료 표시
        };
        
        // 제품 정보 추가
        if (productInfo.title_kr) updateData.title_kr = productInfo.title_kr;
        if (productInfo.brand) updateData.brand = productInfo.brand;
        if (productInfo.price_current) updateData.price_current = productInfo.price_current;
        if (productInfo.price_original) updateData.price_original = productInfo.price_original;
        
        // 이미지 추가
        if (attachments.length > 0) {
            updateData.product_images = attachments;
        }
        
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [updateData],
            { 
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        console.log(`✅ 업데이트 완료!`);
        console.log(`   - title_kr: ${productInfo.title_kr?.substring(0, 30) || 'N/A'}...`);
        console.log(`   - brand: ${productInfo.brand || 'N/A'}`);
        console.log(`   - price: ₩${productInfo.price_current?.toLocaleString() || 'N/A'}`);
        console.log(`   - images: ${attachments.length}개`);
        console.log(`   - scraped_at: ${scrapedAt}\n`);
        
        return true;

    } catch (error) {
        console.error('❌ 업데이트 실패:', error.response?.data || error.message);
        return false;
    }
}

// ==================== 단일 제품 처리 ====================
async function processProductImages(product, productInfo, galleryImages) {
    try {
        if (galleryImages.length === 0) {
            console.log('⚠️  메인 갤러리 이미지를 찾을 수 없습니다.');
            
            // 이미지 없어도 제품 정보는 저장 (scraped_at도 저장되어 다음에 안 나옴)
            if (productInfo.title_kr) {
                return await updateProduct(product.Id, productInfo, []);
            }
            return false;
        }
        
        console.log(`📊 추출된 이미지: ${galleryImages.length}개`);
        galleryImages.slice(0, 3).forEach((img, i) => {
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
            
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // 제품 정보 + 이미지 함께 저장
        const updateSuccess = await updateProduct(product.Id, productInfo, uploadedFiles);
        
        return updateSuccess;
        
    } catch (error) {
        console.error(`\n❌ 처리 중 오류:`, error.message);
        return false;
    }
}

// ==================== 메인 ====================
async function main() {
    console.log('🚀 Phase 1: 제품 정보 + 메인 갤러리 이미지 추출\n');
    console.log('=' .repeat(70) + '\n');
    
    try {
        // 1. NocoDB에서 제품 가져오기 (scraped_at이 없는 것만!)
        const products = await getOliveyoungProducts(PRODUCT_LIMIT, PRODUCT_OFFSET);
        
        if (products.length === 0) {
            console.log('⚠️  처리할 제품이 없습니다.');
            return;
        }
        
        // URL이 있는 제품만 필터링
        const validProducts = products.filter(p => p.product_url);
        
        if (validProducts.length === 0) {
            console.log('⚠️  product_url이 있는 제품이 없습니다.');
            console.log('   Phase 0을 먼저 실행하세요: node phase0-url-collector.js');
            return;
        }
        
        const totalProducts = validProducts.length;
        console.log(`📦 처리할 제품: ${totalProducts}개\n`);
        
        // ✅ 처리할 제품 목록 미리보기
        console.log('📋 처리 대상 제품:');
        validProducts.forEach((p, i) => {
            console.log(`   ${i + 1}. SKU: ${p.sku} | URL: ${p.product_url?.substring(0, 60)}...`);
        });
        console.log('');
        
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
                        '--single-process',
                        '--disable-extensions'
                    ]
                }
            },
            
            requestHandler: async ({ page, request }) => {
                const product = request.userData.product;
                const index = request.userData.index;
                
                console.log(`\n${'='.repeat(70)}`);
                console.log(`📦 [${index + 1}/${totalProducts}] SKU: ${product.sku}`);
                console.log(`🔗 URL: ${request.url.substring(0, 80)}...`);
                console.log('='.repeat(70) + '\n');
                console.log(`📄 페이지 로딩 중...\n`);
                
                try {
                    await page.waitForLoadState('networkidle', { timeout: 30000 });
                    await page.waitForTimeout(2000);
                    
                    // 제품 정보 추출 (개선된 선택자)
                    const productInfo = await page.evaluate(() => {
                        // 제품명 (한국어) - 여러 선택자 시도
                        let titleKr = '';
                        const titleSelectors = [
                            '.prd_name',
                            '.goods_name', 
                            '.product-name',
                            'h1.tit',
                            '.tit_prd',
                            '[class*="prdName"]',
                            '[class*="goods"] h1',
                            'h1'
                        ];
                        
                        for (const selector of titleSelectors) {
                            const el = document.querySelector(selector);
                            if (el && el.textContent.trim().length > 5) {
                                titleKr = el.textContent.trim();
                                break;
                            }
                        }
                        
                        // 브랜드
                        let brand = '';
                        const brandSelectors = [
                            '.prd_brand',
                            '.brand_name',
                            '.brand',
                            '[class*="brand"]',
                            '.goods_brand'
                        ];
                        
                        for (const selector of brandSelectors) {
                            const el = document.querySelector(selector);
                            if (el && el.textContent.trim().length > 1) {
                                brand = el.textContent.trim();
                                break;
                            }
                        }
                        
                        // 할인 가격 (현재 가격)
                        let priceCurrent = 0;
                        const priceSelectors = [
                            '.price-2 strong',
                            '.tx_cur',
                            '.price strong',
                            '.final-price',
                            '[class*="price"] strong',
                            '.sale_price'
                        ];
                        
                        for (const selector of priceSelectors) {
                            const el = document.querySelector(selector);
                            if (el) {
                                const text = el.textContent.replace(/[^0-9]/g, '');
                                const num = parseInt(text);
                                if (num > 0) {
                                    priceCurrent = num;
                                    break;
                                }
                            }
                        }
                        
                        // 원래 가격 (할인 전)
                        let priceOriginal = priceCurrent;
                        const originalPriceSelectors = [
                            '.price-1 strike',
                            '.tx_org',
                            '.original-price',
                            'del',
                            '[class*="org"]'
                        ];
                        
                        for (const selector of originalPriceSelectors) {
                            const el = document.querySelector(selector);
                            if (el) {
                                const text = el.textContent.replace(/[^0-9]/g, '');
                                const num = parseInt(text);
                                if (num > 0) {
                                    priceOriginal = num;
                                    break;
                                }
                            }
                        }
                        
                        return {
                            title_kr: titleKr,
                            brand: brand,
                            price_current: priceCurrent,
                            price_original: priceOriginal || priceCurrent
                        };
                    });
                    
                    console.log(`📋 제품 정보 추출:`);
                    console.log(`   - 제품명: ${productInfo.title_kr?.substring(0, 40) || '❌ 없음'}...`);
                    console.log(`   - 브랜드: ${productInfo.brand || '❌ 없음'}`);
                    console.log(`   - 가격: ₩${productInfo.price_current?.toLocaleString() || '❌ 없음'}\n`);
                    
                    // 이미지 추출
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
                        
                        // 선택자로 못 찾으면 큰 이미지 찾기
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
                        console.log(`✅ 갤러리 추출 성공: ${result.method}`);
                        console.log(`📸 ${result.images.length}개 이미지 발견\n`);
                        
                        galleryImages = result.images.filter(img => 
                            img.src.includes('oliveyoung.co.kr') ||
                            img.src.includes('image.oliveyoung')
                        );
                        
                        console.log(`✅ 올리브영 이미지 필터링: ${galleryImages.length}개\n`);
                    } else {
                        console.log('⚠️  메인 갤러리를 찾을 수 없습니다.\n');
                    }
                    
                    // 제품 정보 + 이미지 함께 처리
                    const success = await processProductImages(product, productInfo, galleryImages);
                    
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
        
        // 3. 모든 URL 처리
        const requests = validProducts.map((product, index) => ({
            url: product.product_url,
            userData: {
                product: product,
                index: index
            }
        }));
        
        console.log(`🌐 Crawler 시작 - ${validProducts.length}개 제품 처리\n`);
        
        await crawler.run(requests);
        
        // Playwright 완전 종료 (좀비 프로세스 방지)
        await crawler.teardown();
        
        // 4. 최종 결과
        console.log('\n' + '='.repeat(70));
        console.log('🎉 Phase 1 완료!');
        console.log('='.repeat(70));
        console.log(`✅ 성공: ${successCount}/${totalProducts}개 제품`);
        console.log(`❌ 실패: ${failedCount}/${totalProducts}개 제품`);
        console.log(`\n💡 다음 단계: Phase 2 실행`);
        console.log(`   node phase2-ai-generate.js`);
        
    } catch (error) {
        console.error('\n❌ 치명적 오류:', error.message);
        console.error(error.stack);
    }
}

main();