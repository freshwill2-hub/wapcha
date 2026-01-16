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

// ✅ 페이지네이션 설정 (0 = 마지막 페이지까지 자동)
const MAX_PAGES = parseInt(process.env.MAX_PAGES) || parseInt(process.argv[4]) || 0;
const UNLIMITED_PAGES = MAX_PAGES === 0;

console.log('🚀 Phase 0: 올리브영 URL 수집기 (페이지네이션 지원)');
console.log('='.repeat(70));
console.log(`📂 카테고리 URL: ${CATEGORY_URL}`);
console.log(`📊 최대 수집 개수: ${MAX_PRODUCTS}`);
console.log(`📄 최대 페이지 수: ${UNLIMITED_PAGES ? '무제한 (마지막까지)' : MAX_PAGES}`);
console.log(`💾 저장 테이블: ${OLIVEYOUNG_TABLE_ID}`);
console.log('='.repeat(70) + '\n');

// ==================== NocoDB: 기존 SKU 확인 (✅ URL → SKU로 변경) ====================
async function getExistingSkus() {
    try {
        console.log('📥 기존 SKU 목록 가져오는 중...');
        
        const allSkus = new Set();
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
                        fields: 'sku'  // ✅ product_url → sku
                    }
                }
            );
            
            const records = response.data.list;
            if (records.length === 0) break;
            
            records.forEach(r => {
                if (r.sku) {
                    allSkus.add(r.sku);
                }
            });
            
            offset += limit;
            
            if (records.length < limit) break;
        }
        
        console.log(`✅ 기존 SKU ${allSkus.size}개 확인됨\n`);
        return allSkus;
        
    } catch (error) {
        console.error('❌ 기존 SKU 조회 실패:', error.message);
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
            console.log(`   ⚠️  이미 존재하는 SKU (무시됨)`);
            return null;
        }
        console.error('❌ 저장 실패:', error.message);
        return null;
    }
}

// ==================== 제품 상세 페이지에서 정보 추출 ====================
async function extractProductInfo(page, url) {
    try {
        // 제품 번호 추출 (SKU)
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
            sku: goodsNo,  // ✅ SKU 저장
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
        console.log('  node phase0-url-collector.js "카테고리URL" [최대개수] [최대페이지수]');
        console.log('  (최대페이지수 0 = 마지막까지)');
        console.log('\n예시:');
        console.log('  node phase0-url-collector.js "https://www.oliveyoung.co.kr/store/main/getBestList.do?dispCatNo=900000100100001" 50 5');
        console.log('  node phase0-url-collector.js "https://..." 100 0   # 마지막 페이지까지');
        return;
    }
    
    // ✅ 기존 SKU 확인 (URL 대신)
    const existingSkus = await getExistingSkus();
    
    const collectedProducts = [];  // {url, sku} 형태로 저장
    let processedCount = 0;
    let savedCount = 0;
    let skippedCount = 0;
    let currentPage = 1;
    let hasMorePages = true;
    
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
        
        maxRequestsPerCrawl: 5000,  // 충분히 크게
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 120,
        
        requestHandler: async ({ page, request }) => {
            const url = request.url;
            const requestType = request.userData?.type || 'category';
            
            // 카테고리 페이지 처리
            if (requestType === 'category') {
                const pageNum = request.userData?.pageNum || 1;
                
                console.log(`\n📄 카테고리 페이지 ${pageNum}${UNLIMITED_PAGES ? '' : '/' + MAX_PAGES} 로딩 중...`);
                
                await page.waitForLoadState('networkidle', { timeout: 30000 });
                await page.waitForTimeout(3000);
                
                // 스크롤하여 더 많은 제품 로드
                console.log('📜 페이지 스크롤 중...');
                
                for (let i = 0; i < 10; i++) {
                    await page.evaluate(() => window.scrollBy(0, 1000));
                    await page.waitForTimeout(800);
                    
                    const currentCount = await page.evaluate(() => {
                        const links = document.querySelectorAll('a[href*="getGoodsDetail.do"]');
                        return links.length;
                    });
                    
                    if (collectedProducts.length + currentCount >= MAX_PRODUCTS) {
                        break;
                    }
                }
                
                // "더보기" 버튼 클릭 시도
                try {
                    const moreButton = await page.$('button.btnMore, a.more, .btn_more');
                    if (moreButton) {
                        for (let i = 0; i < 3; i++) {
                            await moreButton.click();
                            await page.waitForTimeout(1500);
                        }
                    }
                } catch (e) {
                    // 더보기 버튼 없으면 무시
                }
                
                // 제품 URL 및 SKU 추출
                const products = await page.evaluate(() => {
                    const links = document.querySelectorAll('a[href*="getGoodsDetail.do"]');
                    const items = [];
                    const seenSkus = new Set();
                    
                    links.forEach(link => {
                        let href = link.href;
                        if (href && href.includes('goodsNo=')) {
                            const goodsNoMatch = href.match(/goodsNo=([A-Z0-9]+)/);
                            if (goodsNoMatch && !seenSkus.has(goodsNoMatch[1])) {
                                seenSkus.add(goodsNoMatch[1]);
                                items.push({
                                    url: `https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${goodsNoMatch[1]}`,
                                    sku: goodsNoMatch[1]
                                });
                            }
                        }
                    });
                    
                    return items;
                });
                
                console.log(`📊 페이지 ${pageNum}에서 ${products.length}개 제품 발견`);
                
                // ✅ SKU 기반 중복 체크
                const newProducts = products.filter(p => 
                    !existingSkus.has(p.sku) && 
                    !collectedProducts.some(cp => cp.sku === p.sku)
                );
                
                const skippedDuplicates = products.length - newProducts.length;
                console.log(`🆕 새 제품: ${newProducts.length}개 (SKU 중복 ${skippedDuplicates}개 스킵)`);
                
                // 최대 개수까지만 추가
                const remainingSlots = MAX_PRODUCTS - collectedProducts.length;
                const productsToAdd = newProducts.slice(0, remainingSlots);
                
                for (const product of productsToAdd) {
                    collectedProducts.push(product);
                }
                
                console.log(`📦 현재까지 수집: ${collectedProducts.length}/${MAX_PRODUCTS}개`);
                
                // ✅ 다음 페이지 확인 (무제한 모드)
                if (UNLIMITED_PAGES || pageNum < MAX_PAGES) {
                    // 다음 페이지 존재 여부 확인
                    const hasNextPage = await page.evaluate((currentPage) => {
                        // 페이지네이션 요소 확인
                        const pagination = document.querySelector('.pageing, .paging, .pagination');
                        if (pagination) {
                            const nextBtn = pagination.querySelector('a.next, a[class*="next"], .btn_next');
                            if (nextBtn && !nextBtn.classList.contains('disabled')) {
                                return true;
                            }
                            
                            // 숫자 페이지 버튼 확인
                            const pageLinks = pagination.querySelectorAll('a');
                            for (const link of pageLinks) {
                                const pageNum = parseInt(link.textContent);
                                if (pageNum === currentPage + 1) {
                                    return true;
                                }
                            }
                        }
                        
                        // 제품이 있으면 다음 페이지 시도
                        const products = document.querySelectorAll('a[href*="getGoodsDetail.do"]');
                        return products.length > 0;
                    }, pageNum);
                    
                    // 이 페이지에서 새 제품이 없으면 마지막 페이지
                    if (newProducts.length === 0) {
                        console.log(`\n⚠️  페이지 ${pageNum}에서 새 제품 없음 - 마지막 페이지로 판단`);
                        hasMorePages = false;
                    } else if (collectedProducts.length >= MAX_PRODUCTS) {
                        console.log(`\n🎯 목표 수량 달성! (${collectedProducts.length}개)`);
                        hasMorePages = false;
                    } else if (hasNextPage) {
                        hasMorePages = true;
                    } else {
                        console.log(`\n📄 페이지 ${pageNum}이 마지막 페이지입니다`);
                        hasMorePages = false;
                    }
                } else {
                    hasMorePages = false;
                }
            }
            
            // 제품 상세 페이지 처리
            else if (requestType === 'product') {
                processedCount++;
                const productSku = request.userData?.sku || 'unknown';
                
                console.log(`\n[${processedCount}/${collectedProducts.length}] SKU: ${productSku}`);
                console.log(`   URL: ${url.substring(0, 70)}...`);
                
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
                        console.log(`      🏷️  SKU: ${productInfo.sku}`);
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
    
    // ✅ 1단계: 페이지별 URL 수집 (무제한 또는 지정 페이지)
    console.log('📥 1단계: 카테고리 페이지에서 제품 URL 수집\n');
    
    while (hasMorePages && collectedProducts.length < MAX_PRODUCTS) {
        // 페이지네이션 URL 생성
        const pageUrl = new URL(CATEGORY_URL);
        pageUrl.searchParams.set('pageIdx', currentPage.toString());
        
        console.log(`\n${'─'.repeat(70)}`);
        
        await crawler.run([{
            url: pageUrl.toString(),
            userData: { type: 'category', pageNum: currentPage }
        }]);
        
        // 페이지 제한 체크
        if (!UNLIMITED_PAGES && currentPage >= MAX_PAGES) {
            console.log(`\n✅ 최대 페이지 수(${MAX_PAGES}) 도달`);
            break;
        }
        
        currentPage++;
        
        // 페이지 간 대기
        if (hasMorePages && collectedProducts.length < MAX_PRODUCTS) {
            console.log(`⏳ 다음 페이지 로딩 전 2초 대기...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    // 2단계: 각 제품 페이지 방문하여 정보 수집
    if (collectedProducts.length > 0) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📥 2단계: ${collectedProducts.length}개 제품 정보 수집\n`);
        console.log('='.repeat(70));
        
        const productRequests = collectedProducts.map(p => ({
            url: p.url,
            userData: { type: 'product', sku: p.sku }
        }));
        
        await crawler.run(productRequests);
    }
    
    // ✅ 크롤러 정리 (좀비 프로세스 방지)
    await crawler.teardown();
    
    // 최종 결과
    console.log('\n' + '='.repeat(70));
    console.log('🎉 Phase 0 완료!');
    console.log('='.repeat(70));
    console.log(`📊 결과:`);
    console.log(`   - 스캔한 페이지: ${currentPage - 1}개`);
    console.log(`   - 발견된 제품: ${collectedProducts.length}개`);
    console.log(`   - 저장 성공: ${savedCount}개`);
    console.log(`   - 건너뜀/실패: ${skippedCount}개`);
    console.log(`\n💡 다음 단계: node phase1-main-gallery.js`);
}

// 실행
collectUrls().catch(console.error);