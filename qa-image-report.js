import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL;
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GOOGLE_GEMINI_API_KEY);

const SYDNEY_TIMEZONE = 'Australia/Sydney';
const RATE_LIMIT_MS = 6000;
const PAGE_SIZE = 200;

// ==================== 로깅 ====================
function getTimestamp() {
    return new Date().toLocaleString('en-AU', { timeZone: SYDNEY_TIMEZONE, hour12: false });
}

function log(...args) {
    console.log(`[${getTimestamp()}]`, ...args);
}

// ==================== NocoDB API ====================
async function getAllProducts() {
    const allProducts = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { limit: PAGE_SIZE, offset }
            }
        );

        const list = response.data.list || [];
        // validated_images 또는 ai_product_images 또는 main_image가 있는 제품
        const filtered = list.filter(p =>
            hasAttachments(p.validated_images) ||
            hasAttachments(p.ai_product_images) ||
            hasAttachments(p.main_image)
        );
        allProducts.push(...filtered);

        if (list.length < PAGE_SIZE) {
            hasMore = false;
        } else {
            offset += PAGE_SIZE;
        }

        log(`   페이지 로드: offset=${offset}, 이번 ${list.length}건, 유효 ${filtered.length}건`);
    }

    return allProducts;
}

async function getOliveyoungProduct(productId) {
    try {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { where: `(Id,eq,${productId})` }
            }
        );
        if (response.data.list && response.data.list.length > 0) {
            return response.data.list[0];
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ==================== 이미지 URL 추출 ====================
function extractImageUrl(img) {
    // url이 http로 시작하면 그대로 사용
    if (img.url && img.url.startsWith('http')) return img.url;
    // signedPath → NOCODB_API_URL prefix
    if (img.signedPath) return `${NOCODB_API_URL}/${img.signedPath}`;
    // path → NOCODB_API_URL prefix
    if (img.path) return `${NOCODB_API_URL}/${img.path}`;
    return null;
}

function hasAttachments(field) {
    return field && Array.isArray(field) && field.length > 0;
}

// ==================== 이미지 → Base64 ====================
async function imageUrlToBase64(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000
        });
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        const mimeType = response.headers['content-type'] || 'image/png';
        return { base64, mimeType };
    } catch (error) {
        return null;
    }
}

// ==================== Gemini 이미지 분석 ====================
async function analyzeImageQuality(imageUrl, titleEn) {
    const imageData = await imageUrlToBase64(imageUrl);
    if (!imageData) return null;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `이 이미지는 쇼핑몰에 올라갈 화장품 제품 이미지입니다.
제품 타이틀: ${titleEn}

다음 항목을 각각 YES 또는 NO로 판단하고, 해당되면 구체적 설명을 추가하세요.

1. BANNER_잔류: 제품 용기 외에 프로모션 배너, "오늘의 특가", "올영 PICK", 날짜 표시, 대형 한국어 텍스트가 보이나요?
2. GRAPHIC_잔류: 배경 제거 후 남은 잔여물(달, 별, 하트, 캐릭터 그림, 반투명 그래픽)이 보이나요?
3. WRONG_PRODUCT_COUNT: 타이틀에 "2 pcs" 또는 "Set of"가 있으면 해당 개수만큼 보여야 합니다. 타이틀의 세트 개수와 이미지에 보이는 제품 개수가 일치하나요? (세트가 아닌 단일 제품인데 2개 이상 보이면 NO)
4. VOLUME_MISMATCH: 이미지 속 제품에 적힌 용량(ml, g 등)이 타이틀의 용량과 다른가요? (용량이 안 보이면 UNKNOWN)
5. OVER_CROPPED: 제품의 뚜껑, 바닥 등이 잘려서 제품 전체가 보이지 않나요?
6. TOO_SMALL: 이미지에서 제품이 너무 작게 보이거나 (전체 이미지의 30% 미만), 의미 없는 조각만 보이나요?
7. GIFT_INCLUDED: 제품 외에 증정품(파우치, 키체인, 미니어처, 달력 등)이 함께 보이나요?
8. OVERALL_QUALITY: 전문적인 쇼핑몰 제품 이미지로 적합한가요? (GOOD / ACCEPTABLE / POOR)

JSON 형식으로만 응답하세요:
{
  "banner": "YES/NO",
  "banner_detail": "",
  "graphic": "YES/NO",
  "graphic_detail": "",
  "wrong_count": "YES/NO",
  "wrong_count_detail": "",
  "volume_mismatch": "YES/NO/UNKNOWN",
  "volume_detail": "",
  "over_cropped": "YES/NO",
  "crop_detail": "",
  "too_small": "YES/NO",
  "small_detail": "",
  "gift_included": "YES/NO",
  "gift_detail": "",
  "quality": "GOOD/ACCEPTABLE/POOR",
  "quality_detail": ""
}`;

    const result = await model.generateContent([
        prompt,
        { inlineData: { data: imageData.base64, mimeType: imageData.mimeType } }
    ]);

    const responseText = result.response.text();

    // JSON 파싱 시도
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            // JSON 파싱 실패 → raw 텍스트에서 YES/NO 추출
        }
    }

    // Fallback: raw 텍스트에서 추출
    return {
        banner: /banner["\s:]*"?YES/i.test(responseText) ? 'YES' : 'NO',
        banner_detail: '',
        graphic: /graphic["\s:]*"?YES/i.test(responseText) ? 'YES' : 'NO',
        graphic_detail: '',
        wrong_count: /wrong_count["\s:]*"?YES/i.test(responseText) ? 'YES' : 'NO',
        wrong_count_detail: '',
        volume_mismatch: /volume_mismatch["\s:]*"?YES/i.test(responseText) ? 'YES'
            : /volume_mismatch["\s:]*"?UNKNOWN/i.test(responseText) ? 'UNKNOWN' : 'NO',
        volume_detail: '',
        over_cropped: /over_cropped["\s:]*"?YES/i.test(responseText) ? 'YES' : 'NO',
        crop_detail: '',
        too_small: /too_small["\s:]*"?YES/i.test(responseText) ? 'YES' : 'NO',
        small_detail: '',
        gift_included: /gift_included["\s:]*"?YES/i.test(responseText) ? 'YES' : 'NO',
        gift_detail: '',
        quality: /quality["\s:]*"?POOR/i.test(responseText) ? 'POOR'
            : /quality["\s:]*"?ACCEPTABLE/i.test(responseText) ? 'ACCEPTABLE' : 'GOOD',
        quality_detail: ''
    };
}

// ==================== 문제 분류 ====================
function getIssues(analysis) {
    const issues = [];
    if (analysis.banner === 'YES') issues.push('banner');
    if (analysis.graphic === 'YES') issues.push('graphic');
    if (analysis.wrong_count === 'YES') issues.push('wrong_count');
    if (analysis.volume_mismatch === 'YES') issues.push('volume_mismatch');
    if (analysis.over_cropped === 'YES') issues.push('over_cropped');
    if (analysis.too_small === 'YES') issues.push('too_small');
    if (analysis.gift_included === 'YES') issues.push('gift');
    return issues;
}

function formatQualitySummary(analysis) {
    const issues = getIssues(analysis);
    const q = analysis.quality || 'UNKNOWN';
    return issues.length > 0 ? `${q}(${issues.join(',')})` : q;
}

// ==================== 메인 ====================
async function main() {
    log('========================================');
    log('QA 이미지 품질 리포트 생성 시작');
    log('========================================\n');

    // 1. 제품 수집
    log('📦 NocoDB에서 제품 수집 중...');
    const products = await getAllProducts();
    log(`✅ 총 ${products.length}개 제품 수집 완료\n`);

    if (products.length === 0) {
        log('분석할 제품이 없습니다.');
        return;
    }

    // 총 이미지 수 계산
    let totalImages = 0;
    for (const p of products) {
        // validated_images 또는 ai_product_images (1차)
        if (hasAttachments(p.validated_images)) {
            totalImages += p.validated_images.length;
        } else if (hasAttachments(p.ai_product_images)) {
            totalImages += p.ai_product_images.length;
        }
        // main_image + gallery_images (추가)
        if (hasAttachments(p.main_image)) totalImages += p.main_image.length;
        if (hasAttachments(p.gallery_images)) totalImages += p.gallery_images.length;
    }

    const estimatedSeconds = totalImages * 6;
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
    log(`📊 총 분석 이미지: ${totalImages}장`);
    log(`⏱️  예상 소요시간: 약 ${estimatedMinutes}분 (${totalImages}장 × 6초)\n`);

    // 2. 분석 실행
    const allResults = []; // { product, images: [{ position, analysis }] }

    // 통계 카운터
    const stats = {
        banner: [],
        graphic: [],
        wrong_count: [],
        volume_mismatch: [],
        over_cropped: [],
        too_small: [],
        gift: [],
        poor: [],
        totalAnalyzed: 0
    };

    for (let pi = 0; pi < products.length; pi++) {
        const product = products[pi];
        const titleEn = product.title_en || 'Unknown';
        const oliveyoungId = product.oliveyoung_id || product.Id;
        const priceAud = product.price_aud || '';

        // 한국어 타이틀 가져오기
        let titleKr = '';
        if (oliveyoungId) {
            const oyProduct = await getOliveyoungProduct(oliveyoungId);
            if (oyProduct) {
                titleKr = oyProduct.title_kr || oyProduct.title || '';
            }
        }

        const productResult = {
            titleEn,
            titleKr,
            priceAud,
            images: []
        };

        // 이미지 목록 구성: validated → ai_product (fallback) → main/gallery (추가)
        const imageList = [];

        // 1차: validated_images (Phase 3 결과) 또는 ai_product_images (Phase 2 fallback)
        if (hasAttachments(product.validated_images)) {
            product.validated_images.forEach((img, idx) => {
                const url = extractImageUrl(img);
                if (url) imageList.push({ position: `validated-${idx + 1}`, url });
            });
        } else if (hasAttachments(product.ai_product_images)) {
            product.ai_product_images.forEach((img, idx) => {
                const url = extractImageUrl(img);
                if (url) imageList.push({ position: `ai-product-${idx + 1}`, url });
            });
        }

        // 추가: main_image (Phase 4 결과)
        if (hasAttachments(product.main_image)) {
            for (const img of product.main_image) {
                const url = extractImageUrl(img);
                if (url) {
                    imageList.push({ position: 'main', url });
                    break; // main은 1개만
                }
            }
        }

        // 추가: gallery_images (Phase 4 결과)
        if (hasAttachments(product.gallery_images)) {
            product.gallery_images.forEach((img, idx) => {
                const url = extractImageUrl(img);
                if (url) imageList.push({ position: `gallery-${idx + 1}`, url });
            });
        }

        const consoleParts = [];

        for (let ii = 0; ii < imageList.length; ii++) {
            const { position, url } = imageList[ii];

            try {
                const analysis = await analyzeImageQuality(url, titleEn);

                if (analysis) {
                    stats.totalAnalyzed++;
                    productResult.images.push({ position, analysis });

                    // 통계 수집
                    const entry = { titleEn, position };
                    if (analysis.banner === 'YES') stats.banner.push({ ...entry, detail: analysis.banner_detail });
                    if (analysis.graphic === 'YES') stats.graphic.push({ ...entry, detail: analysis.graphic_detail });
                    if (analysis.wrong_count === 'YES') stats.wrong_count.push({ ...entry, detail: analysis.wrong_count_detail });
                    if (analysis.volume_mismatch === 'YES') stats.volume_mismatch.push({ ...entry, detail: analysis.volume_detail });
                    if (analysis.over_cropped === 'YES') stats.over_cropped.push({ ...entry, detail: analysis.crop_detail });
                    if (analysis.too_small === 'YES') stats.too_small.push({ ...entry, detail: analysis.small_detail });
                    if (analysis.gift_included === 'YES') stats.gift.push({ ...entry, detail: analysis.gift_detail });
                    if (analysis.quality === 'POOR') stats.poor.push({ ...entry, detail: analysis.quality_detail });

                    consoleParts.push(`${position}:${formatQualitySummary(analysis)}`);
                } else {
                    consoleParts.push(`${position}:ERROR`);
                }
            } catch (error) {
                consoleParts.push(`${position}:ERROR`);
            }

            // Rate limit
            if (ii < imageList.length - 1 || pi < products.length - 1) {
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
            }
        }

        allResults.push(productResult);

        const shortTitle = titleEn.length > 40 ? titleEn.substring(0, 40) + '...' : titleEn;
        log(`✅ [${pi + 1}/${products.length}] ${shortTitle} ${consoleParts.join(' ')}`);
    }

    // 3. 리포트 생성
    const now = new Date().toLocaleString('en-AU', {
        timeZone: SYDNEY_TIMEZONE, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/[/,\s:]+/g, match => {
        if (match.includes('/') || match.includes(',')) return '-';
        if (match.includes(':')) return '';
        return '-';
    });

    // 좀 더 간단한 타임스탬프 생성
    const d = new Date();
    const sydneyTime = new Date(d.toLocaleString('en-US', { timeZone: SYDNEY_TIMEZONE }));
    const ts = [
        sydneyTime.getFullYear(),
        String(sydneyTime.getMonth() + 1).padStart(2, '0'),
        String(sydneyTime.getDate()).padStart(2, '0'),
        '-',
        String(sydneyTime.getHours()).padStart(2, '0'),
        String(sydneyTime.getMinutes()).padStart(2, '0'),
        String(sydneyTime.getSeconds()).padStart(2, '0')
    ].join('');

    const reportPath = path.join(process.cwd(), `qa-report-${ts}.txt`);

    const pct = (arr) => stats.totalAnalyzed > 0 ? (arr.length / stats.totalAnalyzed * 100).toFixed(1) : '0.0';

    let report = '';
    report += '========================================\n';
    report += `품질 리포트 - ${getTimestamp()}\n`;
    report += `총 분석 제품: ${products.length}개\n`;
    report += `총 분석 이미지: ${stats.totalAnalyzed}장\n`;
    report += '========================================\n\n';

    report += '[요약 통계]\n';
    report += `- 배너 잔여물: ${stats.banner.length}건 (${pct(stats.banner)}%)\n`;
    report += `- 그래픽 잔여물: ${stats.graphic.length}건 (${pct(stats.graphic)}%)\n`;
    report += `- 세트 개수 불일치: ${stats.wrong_count.length}건 (${pct(stats.wrong_count)}%)\n`;
    report += `- 용량 불일치: ${stats.volume_mismatch.length}건 (${pct(stats.volume_mismatch)}%)\n`;
    report += `- 과도한 크롭: ${stats.over_cropped.length}건 (${pct(stats.over_cropped)}%)\n`;
    report += `- 너무 작은 이미지: ${stats.too_small.length}건 (${pct(stats.too_small)}%)\n`;
    report += `- 증정품 포함: ${stats.gift.length}건 (${pct(stats.gift)}%)\n`;
    report += `- 전체 품질 POOR: ${stats.poor.length}건 (${pct(stats.poor)}%)\n`;
    report += '\n';

    // 카테고리별 상세
    report += '[카테고리별 상세]\n\n';

    const categories = [
        { key: 'banner', label: '배너 잔여물' },
        { key: 'graphic', label: '그래픽 잔여물' },
        { key: 'wrong_count', label: '세트 개수 불일치' },
        { key: 'volume_mismatch', label: '용량 불일치' },
        { key: 'over_cropped', label: '과도한 크롭' },
        { key: 'too_small', label: '너무 작은 이미지' },
        { key: 'gift', label: '증정품 포함' },
    ];

    for (const cat of categories) {
        const items = stats[cat.key];
        report += `--- ${cat.label} (${items.length}건) ---\n`;
        if (items.length === 0) {
            report += '(없음)\n';
        } else {
            items.forEach((item, idx) => {
                report += `${idx + 1}. ${item.titleEn} | ${item.position} | ${item.detail || '(상세 없음)'}\n`;
            });
        }
        report += '\n';
    }

    // 제품별 전체 결과
    report += '[제품별 전체 결과]\n\n';

    allResults.forEach((pr, idx) => {
        report += `제품 ${idx + 1}: ${pr.titleEn}\n`;
        report += `  타이틀(KR): ${pr.titleKr || '(없음)'}\n`;
        report += `  가격: $${pr.priceAud || '(없음)'}\n`;

        if (pr.images.length === 0) {
            report += '  (분석 결과 없음)\n';
        } else {
            for (const img of pr.images) {
                const issues = getIssues(img.analysis);
                const issueStr = issues.length > 0 ? issues.join(', ') : '없음';
                report += `  ${img.position}: ${img.analysis.quality || 'UNKNOWN'} | 문제: ${issueStr}\n`;
            }
        }
        report += '\n';
    });

    fs.writeFileSync(reportPath, report, 'utf8');
    log(`\n========================================`);
    log(`📄 리포트 저장 완료: ${reportPath}`);
    log(`========================================`);
}

main().catch(error => {
    console.error('❌ 리포트 생성 실패:', error);
    process.exit(1);
});
