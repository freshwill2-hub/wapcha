import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';
import FormData from 'form-data';

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID || 'mfi4ic7zj2gfixv';

console.log('🔧 설정 확인:');
console.log(`- NocoDB URL: ${NOCODB_API_URL}`);
console.log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);

// ==================== 전역 변수 (중지 기능) ====================
let processedCount = 0;
let successCount = 0;
let failedCount = 0;
let stopRequested = false;
let crawler = null;

// ✅ 중지 신호 처리
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM 받음 - 종료 중...');
    stopRequested = true;
    gracefulShutdown();
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT 받음 - 종료 중...');
    stopRequested = true;
    gracefulShutdown();
});

async function gracefulShutdown() {
    console.log('🔴 강제 종료 요청됨...');
    stopRequested = true;
    
    if (crawler) {
        try {
            await crawler.teardown();
            console.log('✅ 크롤러 종료 완료');
        } catch (e) {
            console.log('⚠️  크롤러 종료 중 에러:', e.message);
        }
    }
    
    console.log('✅ 강제 종료 완료!');
    process.exit(0);
}

// ==================== 커맨드라인 인자 처리 ====================
const args = process.argv.slice(2);
let limit = 3;
let offset = 0;

args.forEach(arg => {
    if (arg.startsWith('--limit=')) {
        limit = parseInt(arg.split('=')[1]) || 3;
    }
    if (arg.startsWith('--offset=')) {
        offset = parseInt(arg.split('=')[1]) || 0;
    }
});

console.log(`- 처리 개수: ${limit}`);
console.log(`- 오프셋: ${offset}`);

// ==================== NocoDB: 미처리 제품 가져오기 ====================
async function getOliveyoungProducts(limit = 100, offset = 0) {
    try {
        console.log('\n📥 NocoDB에서 제품 가져오는 중...');
        
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: { offset: 0, limit: 1000 }
            }
        );

        const allProducts = response.data.list;
        console.log(`📊 전체 제품: ${allProducts.length}개`);
        
        const unscrapedProducts = allProducts.filter(p => !p.scraped_at);
        console.log(`🆕 미처리 제품 (scraped_at 없음): ${unscrapedProducts.length}개`);
        
        const targetProducts = unscrapedProducts.slice(offset, offset + limit);
        console.log(`✅ 처리 대상: ${targetProducts.length}개 (offset: ${offset}, limit: ${limit})`);
        
        return targetProducts;

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
        return Array.isArray(response.data) ? response.data[0] : response.data;

    } catch (error) {
        console.error(`   ❌ 업로드 실패:`, error.response?.data || error.message);
        return null;
    }
}

// ==================== NocoDB: 제품 업데이트 ====================
async function updateProductRecord(recordId, productInfo, uploadedFiles) {
    try {
        console.log(`\n📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        
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
        
        const scrapedAt = new Date().toISOString();
        
        // 1단계: 기존 데이터 삭제
        console.log(`🗑️  기존 product_images 삭제 중...`);
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [{ Id: recordId, product_images: null }],
            { headers: { 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json' } }
        );
        
        // 2단계: 새 데이터 저장
        console.log(`💾 제품 정보 + 이미지 저장 중...`);
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [{ 
                Id: recordId,
                title_kr: productInfo.title_kr || null,
                brand: productInfo.brand || null,
                price_current: productInfo.price_current || 0,
                price_original: productInfo.price_original || 0,
                product_images: attachments.length > 0 ? attachments : null,
                scraped_at: scrapedAt
            }],
            { headers: { 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json' } }
        );
        
        console.log(`✅ 업데이트 완료!`);
        console.log(`   - title_kr: ${productInfo.title_kr?.substring(0, 30) || 'N/A'}...`);
        console.log(`   - brand: ${productInfo.brand || 'N/A'}`);
        console.log(`   - price: ₩${productInfo.price_current?.toLocaleString() || 0}`);
        console.log(`   - images: ${attachments.length}개`);
        console.log(`   - scraped_at: ${scrapedAt}`);
        
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
            console.log('⚠️  메인 갤러리 이미지 없음 - 제품 정보만 저장');
            await updateProductRecord(product.Id, productInfo, []);
            return true;
        }
        
        console.log(`📊 추출된 이미지: ${galleryImages.length}개`);
        galleryImages.slice(0, 3).forEach((img, i) => {
            console.log(`   ${i + 1}. ${img.src.substring(0, 70)}... (${img.width}×${img.height})`);
        });
        
        const maxImages = Math.min(galleryImages.length, 7);
        console.log(`\n📥 ${maxImages}개 이미지 다운로드 & 업로드 중...\n`);
        
        const uploadedFiles = [];
        
        for (let i = 0; i < maxImages; i++) {
            if (stopRequested) {
                console.log('🛑 중지 요청됨 - 이미지 처리 중단');
                break;
            }
            
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
        
        const updateSuccess = await updateProductRecord(product.Id, productInfo, uploadedFiles);
        
        if (updateSuccess) {
            console.log(`✅ 총 ${uploadedFiles.length}개 이미지 + 제품 정보 저장 완료\n`);
            return true;
        } else {
            console.log(`❌ NocoDB 업데이트 실패\n`);
            return false;
        }
        
    } catch (error) {
        console.error(`\n❌ 처리 중 오류:`, error.message);
        return false;
    }
}

// ==================== 메인 ====================
async function main() {
    console.log('\n🚀 Phase 1: 제품 정보 + 메인 갤러리 이미지 추출');
    console.log('=' .repeat(70) + '\n');
    
    try {
        const products = await getOliveyoungProducts(limit, offset);
        
        if (products.length === 0) {
            console.log('⚠️  처리할 제품이 없습니다.');
            return;
        }
        
        console.log(`\n📦 처리할 제품: ${products.length}개`);
        console.log('📋 처리 대상 제품:');
        products.forEach((p, i) => {
            console.log(`   ${i + 1}. SKU: ${p.sku} | URL: ${p.product_url?.substring(0, 70)}...`);
        });
        
        const totalProducts = products.length;
        
        // ✅ Crawlee 설정 - 로딩 방식 개선
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
            
            // ✅ 핵심 변경: navigationTimeoutSecs 증가
            navigationTimeoutSecs: 60,
            requestHandlerTimeoutSecs: 180,
            
            requestHandler: async ({ page, request }) => {
                if (stopRequested) {
                    console.log('🛑 파이프라인 강제 중지됨');
                    return;
                }
                
                const product = request.userData.product;
                const index = request.userData.index;
                
                console.log(`\n${'='.repeat(70)}`);
                console.log(`📦 [${index + 1}/${totalProducts}] SKU: ${product.sku}`);
                console.log(`🔗 URL: ${request.url.substring(0, 100)}...`);
                console.log('='.repeat(70) + '\n');
                console.log(`📄 페이지 로딩 중...\n`);
                
                try {
                    // ✅ 핵심 변경: networkidle 대신 domcontentloaded 사용!
                    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                    
                    // ✅ JS 렌더링을 위한 추가 대기
                    await page.waitForTimeout(5000);
                    
                    // ✅ 제품 정보 추출
                    const productInfo = await page.evaluate(() => {
                        // 제품명 - 올리브영 실제 구조
                        let titleKr = '';
                        const titleEl = document.querySelector('p.prd_name') ||
                                       document.querySelector('.prd_name') ||
                                       document.querySelector('[class*="prd_name"]');
                        if (titleEl) {
                            titleKr = titleEl.textContent.trim();
                        }
                        
                        // 브랜드
                        let brand = '';
                        const brandEl = document.querySelector('.prd_brand a') ||
                                       document.querySelector('.prd_brand');
                        if (brandEl) {
                            brand = brandEl.textContent.trim();
                        }
                        
                        // 할인 가격 (현재 가격) - 올리브영 실제 구조
                        let priceCurrent = 0;
                        const priceSelectors = [
                            '.price-2 strong',
                            '.price-2 span strong',
                            '.total_area strong',
                            '.prd-price strong',
                            '#finalPrc'
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
                        const originalEl = document.querySelector('.price-1 strike') ||
                                          document.querySelector('.tx_org') ||
                                          document.querySelector('del');
                        if (originalEl) {
                            const text = originalEl.textContent.replace(/[^0-9]/g, '');
                            const num = parseInt(text);
                            if (num > 0) {
                                priceOriginal = num;
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
                    console.log(`   - 가격: ₩${productInfo.price_current?.toLocaleString() || '0'}\n`);
                    
                    // ✅ 이미지 추출
                    const images = await page.evaluate(() => {
                        const results = [];
                        
                        const gallerySelectors = [
                            '.swiper-slide img',
                            '.prd-detail-img img',
                            '.goods-img img',
                            '.slider img',
                            '[class*="prdImg"] img',
                            '[class*="goodsImg"] img'
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
                        
                        // 폴백: 큰 이미지
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
                        console.log(`📸 ${result.images.length}개 이미지 발견`);
                        
                        galleryImages = result.images.filter(img => 
                            img.src.includes('oliveyoung.co.kr') ||
                            img.src.includes('image.oliveyoung')
                        );
                        
                        console.log(`✅ 올리브영 이미지 필터링: ${galleryImages.length}개\n`);
                    } else {
                        console.log('⚠️  메인 갤러리를 찾을 수 없습니다.\n');
                    }
                    
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
            maxConcurrency: 1
        });
        
        const requests = products.map((product, index) => ({
            url: product.product_url,
            userData: { product, index }
        }));
        
        console.log(`\n🌐 Crawler 시작 - ${products.length}개 제품 처리\n`);
        
        await crawler.run(requests);
        
        // ✅ 크롤러 완전 종료
        console.log('\n🔧 크롤러 정리 중...');
        await crawler.teardown();
        console.log('✅ 크롤러 정리 완료');
        
        // 최종 결과
        console.log('\n' + '='.repeat(70));
        console.log('🎉 Phase 1 완료!');
        console.log('='.repeat(70));
        console.log(`✅ 성공: ${successCount}/${totalProducts}개 제품`);
        console.log(`❌ 실패: ${failedCount}/${totalProducts}개 제품`);
        console.log(`\n💡 다음 단계: Phase 2 실행`);
        
    } catch (error) {
        console.error('\n❌ 치명적 오류:', error.message);
        console.error(error.stack);
    } finally {
        if (crawler) {
            try {
                await crawler.teardown();
            } catch (e) {
                // 무시
            }
        }
    }
}

main();