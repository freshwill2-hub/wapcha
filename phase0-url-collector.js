import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;

// 환경변수 또는 인자로 받기
const CATEGORY_URL = process.env.CATEGORY_URL || process.argv[2];
const MAX_PRODUCTS = parseInt(process.env.MAX_PRODUCTS) || parseInt(process.argv[3]) || 100;

console.log('🚀 Phase 0: 올리브영 URL 수집기');
console.log('='.repeat(70));
console.log(`📂 카테고리 URL: ${CATEGORY_URL}`);
console.log(`📊 최대 수집 개수: ${MAX_PRODUCTS}`);
console.log(`💾 저장 테이블: ${OLIVEYOUNG_TABLE_ID}`);
console.log('='.repeat(70) + '\n');

// ==================== NocoDB: 기존 URL 확인 ====================
async function getExistingUrls() {
    try {
        console.log('📥 기존 URL 목록 가져오는 중...');
        
        const allUrls = new Set();
        let offset = 0;
        const limit = 100;
        
        while (true) {
            const response = await axios.get(
                `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
                {
                    headers: { 'xc-token': NOCODB_TOKEN },
                    params: { 
                        limit: limit, 
                        offset: offset,
                        fields: 'product_url'
                    }
                }
            );
            
            const records = response.data.list;
            if (records.length === 0) break;
            
            records.forEach(r => {
                if (r.product_url) {
                    allUrls.add(r.product_url);
                }
            });
            
            offset += limit;
            
            if (records.length < limit) break;
        }
        
        console.log(`✅ 기존 URL ${allUrls.size}개 확인됨\n`);
        return allUrls;
        
    } catch (error) {
        console.error('❌ 기존 URL 조회 실패:', error.message);
        return new Set();
    }
}

// ==================== NocoDB: 제품 저장 ====================
async function saveProduct(productData) {
    try {
        const response = await axios.post(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            productData,
            {
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
        
    } catch (error) {
        // 중복 에러는 무시
        if (error.response?.status === 422 || error.message.includes('duplicate')) {
            console.log(`   ⚠️  이미 존재하는 URL (무시됨)`);
            return null;
        }
        console.error('❌ 저장 실패:', error.message);
        return null;
    }
}

// ==================== 제품 상세 페이지에서 정보 추출 ====================
async function extractProductInfo(page, url) {
    try {
        // 제품 번호 추출
        const goodsNoMatch = url.match(/goodsNo=([A-Z0-9]+)/);
        const goodsNo = goodsNoMatch ? goodsNoMatch[1] : null;
        
        // 페이지에서 정보 추출
        const info = await page.evaluate(() => {
            // 제품명 (한국어)
            const titleEl = document.querySelector('.prd_name') || 
                           document.querySelector('.goods_name') ||
                           document.querySelector('h1');
            const titleKr = titleEl?.textContent?.trim() || '';
            
            // 브랜드
            const brandEl = document.querySelector('.prd_brand') ||
                           document.querySelector('.brand_name');
            const brand = brandEl?.textContent?.trim() || '';
            
            // 가격
            const priceEl = document.querySelector('.price-2 strong') ||
                           document.querySelector('.tx_cur') ||
                           document.querySelector('.price strong');
            let priceText = priceEl?.textContent?.trim() || '0';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // 원래 가격 (할인 전)
            const originalPriceEl = document.querySelector('.price-1 strike') ||
                                   document.querySelector('.tx_org');
            let originalPriceText = originalPriceEl?.textContent?.trim() || priceText;
            const originalPrice = parseInt(originalPriceText.replace(/[^0-9]/g, '')) || price;
            
            return {
                title_kr: titleKr,
                brand: brand,
                price_current: price,
                price_original: originalPrice
            };
        });
        
        return {
            sku: goodsNo,
            product_url: url,
            title_kr: info.title_kr,
            brand: info.brand,
            price_current: info.price_current,
            price_original: info.price_original,
            collected_at: new Date().toISOString()
        };
        
    } catch (error) {
        console.error('   ❌ 정보 추출 실패:', error.message);
        return null;
    }
}

// ==================== 메인: 카테고리 스크래핑 ====================
async function collectUrls() {
    if (!CATEGORY_URL) {
        console.error('❌ 카테고리 URL이 필요합니다!');
        console.log('\n사용법:');
        console.log('  node phase0-url-collector.js "카테고리URL" [최대개수]');
        console.log('\n예시:');
        console.log('  node phase0-url-collector.js "https://www.oliveyoung.co.kr/store/main/getBestList.do?dispCatNo=900000100100001" 50');
        return;
    }
    
    // 기존 URL 확인
    const existingUrls = await getExistingUrls();
    
    const collectedProducts = [];
    let processedCount = 0;
    let savedCount = 0;
    let skippedCount = 0;
    
    // Playwright 크롤러 설정
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
        
        maxRequestsPerCrawl: MAX_PRODUCTS + 10,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 120,
        
        requestHandler: async ({ page, request }) => {
            const url = request.url;
            
            // 카테고리 페이지 처리
            if (url.includes('getBestList.do') || url.includes('dispCatNo')) {
                console.log('📄 카테고리 페이지 로딩 중...');
                
                await page.waitForLoadState('networkidle', { timeout: 30000 });
                await page.waitForTimeout(3000);
                
                // 스크롤하여 더 많은 제품 로드
                console.log('📜 페이지 스크롤 중 (더 많은 제품 로드)...');
                
                for (let i = 0; i < 10; i++) {
                    await page.evaluate(() => window.scrollBy(0, 1000));
                    await page.waitForTimeout(1000);
                    
                    // 현재 로드된 제품 수 확인
                    const currentCount = await page.evaluate(() => {
                        const links = document.querySelectorAll('a[href*="getGoodsDetail.do"]');
                        return links.length;
                    });
                    
                    if (currentCount >= MAX_PRODUCTS) {
                        console.log(`   ✅ ${currentCount}개 제품 로드됨 (목표 달성)`);
                        break;
                    }
                    
                    console.log(`   📊 ${currentCount}개 제품 로드됨...`);
                }
                
                // "더보기" 버튼 클릭 시도
                try {
                    const moreButton = await page.$('button.btnMore, a.more, .btn_more');
                    if (moreButton) {
                        for (let i = 0; i < 5; i++) {
                            await moreButton.click();
                            await page.waitForTimeout(2000);
                            console.log(`   📥 더보기 클릭 ${i + 1}회`);
                        }
                    }
                } catch (e) {
                    // 더보기 버튼 없으면 무시
                }
                
                // 제품 URL 추출
                const productUrls = await page.evaluate(() => {
                    const links = document.querySelectorAll('a[href*="getGoodsDetail.do"]');
                    const urls = new Set();
                    
                    links.forEach(link => {
                        let href = link.href;
                        if (href && href.includes('goodsNo=')) {
                            // URL 정리
                            const goodsNoMatch = href.match(/goodsNo=([A-Z0-9]+)/);
                            if (goodsNoMatch) {
                                urls.add(`https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${goodsNoMatch[1]}`);
                            }
                        }
                    });
                    
                    return Array.from(urls);
                });
                
                console.log(`\n📊 총 ${productUrls.length}개 제품 URL 발견`);
                
                // 새 URL만 필터링
                const newUrls = productUrls.filter(url => !existingUrls.has(url));
                console.log(`🆕 새 URL: ${newUrls.length}개 (기존 ${productUrls.length - newUrls.length}개 제외)`);
                
                // 최대 개수만큼만 처리
                const urlsToProcess = newUrls.slice(0, MAX_PRODUCTS);
                console.log(`🎯 처리할 URL: ${urlsToProcess.length}개\n`);
                
                // 각 제품 URL을 큐에 추가
                for (const productUrl of urlsToProcess) {
                    collectedProducts.push(productUrl);
                }
            }
            
            // 제품 상세 페이지 처리
            else if (url.includes('getGoodsDetail.do')) {
                processedCount++;
                console.log(`\n[${processedCount}/${collectedProducts.length}] 제품 정보 수집 중...`);
                console.log(`   URL: ${url.substring(0, 80)}...`);
                
                await page.waitForLoadState('networkidle', { timeout: 30000 });
                await page.waitForTimeout(2000);
                
                // 제품 정보 추출
                const productInfo = await extractProductInfo(page, url);
                
                if (productInfo && productInfo.title_kr) {
                    // NocoDB에 저장
                    const saved = await saveProduct(productInfo);
                    
                    if (saved) {
                        savedCount++;
                        console.log(`   ✅ 저장됨: ${productInfo.title_kr.substring(0, 40)}...`);
                        console.log(`      💰 가격: ₩${productInfo.price_current?.toLocaleString()}`);
                    }
                } else {
                    console.log(`   ⚠️  정보 추출 실패`);
                    skippedCount++;
                }
                
                // Rate limiting
                await page.waitForTimeout(1000);
            }
        },
        
        failedRequestHandler: async ({ request }) => {
            console.error(`❌ 실패: ${request.url}`);
            skippedCount++;
        }
    });
    
    // 1단계: 카테고리 페이지에서 URL 수집
    console.log('📥 1단계: 카테고리 페이지에서 제품 URL 수집\n');
    await crawler.run([CATEGORY_URL]);
    
    // 2단계: 각 제품 페이지 방문하여 정보 수집
    if (collectedProducts.length > 0) {
        console.log(`\n📥 2단계: ${collectedProducts.length}개 제품 정보 수집\n`);
        console.log('='.repeat(70));
        
        await crawler.run(collectedProducts);
    }
    
    // 최종 결과
    console.log('\n' + '='.repeat(70));
    console.log('🎉 Phase 0 완료!');
    console.log('='.repeat(70));
    console.log(`📊 결과:`);
    console.log(`   - 발견된 URL: ${collectedProducts.length}개`);
    console.log(`   - 저장 성공: ${savedCount}개`);
    console.log(`   - 건너뜀/실패: ${skippedCount}개`);
    console.log(`\n💡 다음 단계: node phase1-main-gallery.js`);
}

// 실행
collectUrls().catch(console.error);
