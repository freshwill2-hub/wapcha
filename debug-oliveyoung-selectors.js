import 'dotenv/config';
import { chromium } from 'playwright';

// ==================== 올리브영 HTML 구조 분석 스크립트 (v2) ====================
// networkidle 대신 domcontentloaded 사용 + 수동 대기

const TEST_URL = 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A000000200724';

async function debugSelectors() {
    console.log('🔍 올리브영 CSS 선택자 디버깅 시작 (v2)\n');
    console.log(`📄 테스트 URL: ${TEST_URL}\n`);
    
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    
    const page = await browser.newPage();
    
    // User-Agent 설정
    await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    try {
        console.log('⏳ 페이지 로딩 중 (domcontentloaded 방식)...');
        
        // ✅ networkidle 대신 domcontentloaded 사용
        await page.goto(TEST_URL, { 
            waitUntil: 'domcontentloaded',  // ← 핵심 변경!
            timeout: 60000 
        });
        
        // 추가 대기 (JS 렌더링 시간)
        console.log('⏳ 5초 추가 대기 (JS 렌더링)...');
        await page.waitForTimeout(5000);
        
        console.log('✅ 페이지 로딩 완료\n');
        
        // ==================== 제목 선택자 테스트 ====================
        console.log('=' .repeat(60));
        console.log('📝 제목 선택자 테스트');
        console.log('=' .repeat(60));
        
        const titleSelectors = [
            'p.prd_name',
            '.prd_name',
            '.goods_name',
            'h2.prd_name',
            'h3.prd_name',
            '[class*="prd_name"]',
            '[class*="goods_name"]',
            '.prd-info p.prd_name',
            '#Contents .prd_name',
            '.right_area .prd_name'
        ];
        
        for (const selector of titleSelectors) {
            const result = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.textContent.trim().substring(0, 60) : null;
            }, selector);
            
            if (result) {
                console.log(`✅ ${selector.padEnd(35)} → "${result}"`);
            } else {
                console.log(`❌ ${selector.padEnd(35)} → 없음`);
            }
        }
        
        // ==================== 브랜드 선택자 테스트 ====================
        console.log('\n' + '=' .repeat(60));
        console.log('🏷️  브랜드 선택자 테스트');
        console.log('=' .repeat(60));
        
        const brandSelectors = [
            '.prd_brand',
            '.prd_brand a',
            '.brand_name',
            '.brand a',
            '[class*="brand"] a'
        ];
        
        for (const selector of brandSelectors) {
            const result = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.textContent.trim() : null;
            }, selector);
            
            if (result) {
                console.log(`✅ ${selector.padEnd(35)} → "${result}"`);
            } else {
                console.log(`❌ ${selector.padEnd(35)} → 없음`);
            }
        }
        
        // ==================== 가격 선택자 테스트 ====================
        console.log('\n' + '=' .repeat(60));
        console.log('💰 가격 선택자 테스트');
        console.log('=' .repeat(60));
        
        const priceSelectors = [
            '.price-2 strong',
            '.price-2 span strong',
            '.tx_cur',
            '.prd-price strong',
            '.price strong',
            '#finalPrc',
            '.total_area strong',
            '.price_area strong'
        ];
        
        for (const selector of priceSelectors) {
            const result = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const text = el.textContent.trim();
                const num = parseInt(text.replace(/[^0-9]/g, ''));
                return num > 0 ? { text, num } : null;
            }, selector);
            
            if (result) {
                console.log(`✅ ${selector.padEnd(35)} → "${result.text}" (₩${result.num.toLocaleString()})`);
            } else {
                console.log(`❌ ${selector.padEnd(35)} → 없음`);
            }
        }
        
        // ==================== 실제 HTML 덤프 ====================
        console.log('\n' + '=' .repeat(60));
        console.log('🔎 실제 페이지에서 찾은 정보');
        console.log('=' .repeat(60));
        
        const pageData = await page.evaluate(() => {
            const data = {};
            
            // 제목 - 다양한 방법 시도
            const titleEl = document.querySelector('.prd_name') || 
                           document.querySelector('p.prd_name') ||
                           document.querySelector('[class*="prd_name"]');
            data.title = titleEl ? titleEl.textContent.trim() : 'NOT FOUND';
            data.titleSelector = titleEl ? titleEl.className : 'N/A';
            
            // 브랜드
            const brandEl = document.querySelector('.prd_brand a') ||
                           document.querySelector('.prd_brand');
            data.brand = brandEl ? brandEl.textContent.trim() : 'NOT FOUND';
            
            // 가격 - 여러 위치 확인
            const priceEl = document.querySelector('.price-2 strong') ||
                           document.querySelector('.total_area strong') ||
                           document.querySelector('.prd-price strong');
            if (priceEl) {
                data.priceText = priceEl.textContent.trim();
                data.priceNum = parseInt(priceEl.textContent.replace(/[^0-9]/g, ''));
            } else {
                data.priceText = 'NOT FOUND';
                data.priceNum = 0;
            }
            
            // 페이지에 있는 모든 가격 관련 요소 찾기
            const allStrong = document.querySelectorAll('strong');
            data.allPrices = [];
            allStrong.forEach(el => {
                const text = el.textContent.trim();
                const num = parseInt(text.replace(/[^0-9]/g, ''));
                if (num > 1000 && num < 1000000 && text.includes('원') || text.includes(',')) {
                    data.allPrices.push({
                        text: text.substring(0, 30),
                        num: num,
                        class: el.className || el.parentElement?.className
                    });
                }
            });
            
            // 이미지 개수
            const images = document.querySelectorAll('.swiper-slide img');
            data.imageCount = images.length;
            
            return data;
        });
        
        console.log(`\n📝 제목: "${pageData.title}"`);
        console.log(`   선택자: ${pageData.titleSelector}`);
        console.log(`🏷️  브랜드: "${pageData.brand}"`);
        console.log(`💰 가격: "${pageData.priceText}" (₩${pageData.priceNum?.toLocaleString() || 0})`);
        console.log(`🖼️  이미지: ${pageData.imageCount}개`);
        
        if (pageData.allPrices.length > 0) {
            console.log(`\n💵 페이지에서 찾은 모든 가격:`);
            pageData.allPrices.forEach((p, i) => {
                console.log(`   ${i + 1}. "${p.text}" (₩${p.num?.toLocaleString()}) - class: ${p.class}`);
            });
        }
        
        // ==================== 스크린샷 저장 ====================
        console.log('\n📸 스크린샷 저장 중...');
        await page.screenshot({ path: '/tmp/oliveyoung-debug.png', fullPage: false });
        console.log('✅ 저장됨: /tmp/oliveyoung-debug.png');
        
        console.log('\n' + '=' .repeat(60));
        console.log('✅ 디버깅 완료!');
        console.log('=' .repeat(60));
        
    } catch (error) {
        console.error('❌ 오류:', error.message);
    } finally {
        await browser.close();
    }
}

debugSelectors();