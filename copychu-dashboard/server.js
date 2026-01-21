import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn, execSync } from 'child_process';  // ✅ execSync 추가
import cron from 'node-cron';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 설정 ====================
const PORT = process.env.DASHBOARD_PORT || 3000;
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || '/root/copychu-scraper';

console.log('🔧 환경 변수 확인:');
console.log(`- NOCODB_API_URL: ${NOCODB_API_URL}`);
console.log(`- OLIVEYOUNG_TABLE_ID: ${OLIVEYOUNG_TABLE_ID}`);
console.log(`- SHOPIFY_TABLE_ID: ${SHOPIFY_TABLE_ID}`);
console.log(`- SCRIPTS_DIR: ${SCRIPTS_DIR}`);

// ==================== Express + Socket.io ====================
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 상태 관리 ====================
let systemState = {
    status: 'idle', // idle, running, paused, error
    currentPhase: null,
    currentProduct: 0,
    totalProducts: 0,
    startTime: null,
    pausedAt: null,
    errors: [],
    stats: {
        totalProcessed: 0,
        successCount: 0,
        failedCount: 0,
        apiCalls: 0,
        estimatedCost: 0
    }
};

let currentProcess = null;
let isPaused = false;
let scheduledJobs = [];

// 설정 저장 파일
const CONFIG_FILE = path.join(__dirname, 'config.json');

// 기본 설정
let config = {
    productLimit: 3,
    oliveyoungUrl: '',
    minScoreForGallery: 70,
    targetImageSize: 1200,
    productRatio: 0.75,
    geminiApiKey: '',
    maxVolumeLimit: 700,  // ✅ v2.9: 용량 제한 (ml) - 0이면 무제한
    schedules: [],
    phases: {
        phase1: true,
        phase2: true,
        phase3: true,
        phase4: true,
        phase5: true  // ✅ Phase 5 추가!
    }
};

// 설정 로드
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            config = { ...config, ...JSON.parse(data) };
            console.log('✅ 설정 로드 완료');
        }
    } catch (error) {
        console.error('❌ 설정 로드 실패:', error.message);
    }
}

// 설정 저장
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('✅ 설정 저장 완료');
    } catch (error) {
        console.error('❌ 설정 저장 실패:', error.message);
    }
}

loadConfig();

// ==================== URL 큐 관리 ====================
const URL_QUEUE_FILE = path.join(__dirname, 'url-queue.json');

let urlQueue = {
    categories: [],
    products: []
};

function loadUrlQueue() {
    try {
        if (fs.existsSync(URL_QUEUE_FILE)) {
            const data = fs.readFileSync(URL_QUEUE_FILE, 'utf-8');
            urlQueue = JSON.parse(data);
            console.log('✅ URL 큐 로드 완료');
        }
    } catch (error) {
        console.error('❌ URL 큐 로드 실패:', error.message);
    }
}

function saveUrlQueue() {
    try {
        fs.writeFileSync(URL_QUEUE_FILE, JSON.stringify(urlQueue, null, 2));
    } catch (error) {
        console.error('❌ URL 큐 저장 실패:', error.message);
    }
}

loadUrlQueue();

// ==================== 로그 관리 (✅ 시간 포맷 추가) ====================
const logs = [];
const MAX_LOGS = 1000;

// ✅ 시간 포맷 함수
function formatTime(date) {
    const d = new Date(date);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function addLog(type, message, phase = null) {
    const now = new Date();
    const log = {
        id: uuidv4(),
        timestamp: now.toISOString(),
        timeFormatted: formatTime(now),  // ✅ 포맷된 시간 추가
        type, // info, success, error, warning
        message,
        phase
    };
    
    logs.push(log);
    if (logs.length > MAX_LOGS) {
        logs.shift();
    }
    
    io.emit('log', log);
    return log;
}

// ==================== 실행 이력 ====================
const executionHistory = [];

function addExecutionHistory(execution) {
    executionHistory.unshift(execution);
    if (executionHistory.length > 100) {
        executionHistory.pop();
    }
}

// ==================== 이미지 URL 헬퍼 함수 ====================
function getImageUrl(imageData) {
    if (!imageData) return null;
    
    const img = Array.isArray(imageData) ? imageData[0] : imageData;
    if (!img) return null;
    
    if (img.url && img.url.startsWith('http')) {
        return img.url;
    }
    
    if (img.signedPath) {
        return `${NOCODB_API_URL}/${img.signedPath}`;
    }
    
    if (img.path) {
        return `${NOCODB_API_URL}/${img.path}`;
    }
    
    if (img.url) {
        return `${NOCODB_API_URL}/${img.url}`;
    }
    
    return null;
}

// ==================== Phase 정의 ====================
const PHASES = [
    { id: 'phase0', name: 'Phase 0: URL 수집', script: 'phase0-url-collector.js' },
    { id: 'phase1', name: 'Phase 1: 스크래핑', script: 'phase1-main-gallery.js' },
    { id: 'phase2', name: 'Phase 2: 배경 제거', script: 'phase2-ai-generate.js' },
    { id: 'phase3', name: 'Phase 3: AI 크롭', script: 'phase3-multi-3products.js' },
    { id: 'phase4', name: 'Phase 4: 이미지 선별', script: 'phase4-final-data.js' },
    { id: 'phase5', name: 'Phase 5: Shopify 업로드', script: 'phase5-shopify-upload.js' }  // ✅ Phase 5 추가!
];

// ==================== Phase 0: URL 수집 (✅ maxPages 0 = 무제한) ====================
async function runPhase0(categoryUrl, maxProducts, categoryName, maxPages = 0) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPTS_DIR, 'phase0-url-collector.js');
        
        if (!fs.existsSync(scriptPath)) {
            addLog('error', `❌ Phase 0 스크립트 없음: ${scriptPath}`, 'phase0');
            reject(new Error('phase0-url-collector.js not found'));
            return;
        }
        
        const pagesText = maxPages === 0 ? '무제한' : `${maxPages}페이지`;
        addLog('info', `🚀 Phase 0 시작: ${categoryName || '카테고리'} (최대 ${maxProducts}개, ${pagesText})`, 'phase0');
        
        const env = {
            ...process.env,
            CATEGORY_URL: categoryUrl,
            MAX_PRODUCTS: maxProducts.toString(),
            MAX_PAGES: maxPages.toString()  // ✅ 0이면 무제한
        };
        
        const child = spawn('node', [scriptPath], {
            cwd: SCRIPTS_DIR,
            env: env
        });
        
        currentProcess = child;
        
        child.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            lines.forEach(line => {
                let logType = 'info';
                if (line.includes('✅') || line.includes('완료')) logType = 'success';
                if (line.includes('❌') || line.includes('실패')) logType = 'error';
                if (line.includes('⚠️')) logType = 'warning';
                
                addLog(logType, line, 'phase0');
            });
            io.emit('state', systemState);
        });
        
        child.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                addLog('error', message, 'phase0');
            }
        });
        
        child.on('close', (code) => {
            currentProcess = null;
            if (code === 0) {
                addLog('success', `✅ Phase 0 완료: ${categoryName || '카테고리'}`, 'phase0');
                resolve(true);
            } else {
                addLog('error', `❌ Phase 0 실패 (코드: ${code})`, 'phase0');
                reject(new Error(`Phase 0 failed with code ${code}`));
            }
        });
        
        child.on('error', (error) => {
            currentProcess = null;
            addLog('error', `❌ Phase 0 오류: ${error.message}`, 'phase0');
            reject(error);
        });
    });
}

// URL 큐 전체 처리 (✅ maxPages 지원)
async function processUrlQueue() {
    if (systemState.status === 'running') {
        throw new Error('이미 실행 중입니다');
    }
    
    const pendingCategories = urlQueue.categories.filter(c => c.status === 'pending');
    
    if (pendingCategories.length === 0) {
        throw new Error('처리할 카테고리가 없습니다');
    }
    
    systemState.status = 'running';
    systemState.currentPhase = 'phase0';
    io.emit('state', systemState);
    
    addLog('info', `📥 URL 큐 처리 시작: ${pendingCategories.length}개 카테고리`);
    
    let totalCollected = 0;
    
    for (const category of pendingCategories) {
        try {
            category.status = 'processing';
            saveUrlQueue();
            io.emit('urlQueue', urlQueue);
            
            // ✅ maxPages 전달 (없으면 0 = 무제한)
            const maxPages = category.maxPages !== undefined ? category.maxPages : 0;
            await runPhase0(category.url, category.maxProducts, category.name, maxPages);
            
            category.status = 'completed';
            category.completedAt = new Date().toISOString();
            totalCollected += category.maxProducts;
            
            saveUrlQueue();
            io.emit('urlQueue', urlQueue);
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
        } catch (error) {
            category.status = 'error';
            category.error = error.message;
            saveUrlQueue();
            io.emit('urlQueue', urlQueue);
            
            addLog('error', `❌ 카테고리 처리 실패: ${category.name} - ${error.message}`);
        }
    }
    
    systemState.status = 'idle';
    systemState.currentPhase = null;
    io.emit('state', systemState);
    
    addLog('success', `🎉 URL 큐 처리 완료! 약 ${totalCollected}개 제품 수집됨`);
    
    return { success: true, totalCollected };
}

// ==================== 통합 로그 시스템 ====================
function getSydneyTimeForFile() {
    const now = new Date();
    const sydneyDate = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
    const year = sydneyDate.getFullYear();
    const month = String(sydneyDate.getMonth() + 1).padStart(2, '0');
    const day = String(sydneyDate.getDate()).padStart(2, '0');
    const hour = String(sydneyDate.getHours()).padStart(2, '0');
    const min = String(sydneyDate.getMinutes()).padStart(2, '0');
    const sec = String(sydneyDate.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hour}${min}${sec}`;
}

function createUnifiedLogPath() {
    const logsDir = path.join(SCRIPTS_DIR, 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    const filename = `pipeline_${getSydneyTimeForFile()}.log`;
    return path.join(logsDir, filename);
}

function writeUnifiedLog(logPath, message) {
    if (!logPath) return;
    const timestamp = new Date().toLocaleString('en-AU', {
        timeZone: 'Australia/Sydney',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
}

// ==================== 파이프라인 실행 ====================
// ✅ 수정: categoryUrl 옵션 추가
async function runPhase(phase, productLimit, categoryUrl = null, maxProducts = null, maxPages = null, unifiedLogPath = null) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPTS_DIR, phase.script);
        
        if (!fs.existsSync(scriptPath)) {
            addLog('error', `❌ 스크립트 파일 없음: ${scriptPath}`, phase.id);
            reject(new Error(`Script not found: ${scriptPath}`));
            return;
        }
        
        addLog('info', `🚀 ${phase.name} 시작 (${productLimit}개 제품)`, phase.id);
        
        // ✅ 환경변수 설정 - categoryUrl이 있으면 추가
        const env = {
            ...process.env,
            PRODUCT_LIMIT: productLimit.toString(),
            MAX_VOLUME_LIMIT: (config.maxVolumeLimit || 0).toString()  // ✅ v2.9: 용량 제한 전달
        };

        // ✅ 통합 로그 경로 전달
        if (unifiedLogPath) {
            env.UNIFIED_LOG_PATH = unifiedLogPath;
        }

        // ✅ Phase 0인 경우 URL 관련 환경변수 추가
        if (phase.id === 'phase0' && categoryUrl) {
            env.CATEGORY_URL = categoryUrl;
            env.MAX_PRODUCTS = (maxProducts || productLimit).toString();
            env.MAX_PAGES = (maxPages || 0).toString();
            addLog('info', `📂 URL: ${categoryUrl.substring(0, 60)}...`, phase.id);
        }
        
        const child = spawn('node', [scriptPath], {
            cwd: SCRIPTS_DIR,
            env: env
        });
        
        currentProcess = child;
        
        child.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            
            lines.forEach(line => {
                const productMatch = line.match(/\[(\d+)\/(\d+)\]/);
                if (productMatch) {
                    systemState.currentProduct = parseInt(productMatch[1]);
                    systemState.totalProducts = parseInt(productMatch[2]);
                    io.emit('progress', {
                        current: systemState.currentProduct,
                        total: systemState.totalProducts,
                        phase: phase.id
                    });
                }
                
                if (line.includes('Gemini') || line.includes('API')) {
                    systemState.stats.apiCalls++;
                    systemState.stats.estimatedCost = systemState.stats.apiCalls * 0.0001;
                }
                
                if (line.includes('✅') || line.includes('성공')) {
                    systemState.stats.successCount++;
                }
                if (line.includes('❌') || line.includes('실패')) {
                    systemState.stats.failedCount++;
                }
                
                let logType = 'info';
                if (line.includes('✅') || line.includes('완료')) logType = 'success';
                if (line.includes('❌') || line.includes('실패') || line.includes('오류')) logType = 'error';
                if (line.includes('⚠️') || line.includes('경고')) logType = 'warning';
                
                addLog(logType, line, phase.id);
            });
            
            io.emit('state', systemState);
        });
        
        child.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                addLog('error', message, phase.id);
                systemState.errors.push({
                    phase: phase.id,
                    message: message,
                    timestamp: new Date().toISOString()
                });
            }
        });
        
        child.on('close', (code) => {
            currentProcess = null;
            
            if (code === 0) {
                addLog('success', `✅ ${phase.name} 완료`, phase.id);
                resolve(true);
            } else {
                addLog('error', `❌ ${phase.name} 실패 (코드: ${code})`, phase.id);
                reject(new Error(`Phase ${phase.id} failed with code ${code}`));
            }
        });
        
        child.on('error', (error) => {
            currentProcess = null;
            addLog('error', `❌ ${phase.name} 오류: ${error.message}`, phase.id);
            reject(error);
        });
    });
}

// ✅ 수정: categoryUrl 옵션 추가 + 통합 로그 지원
async function runPipeline(options = {}) {
    const {
        productLimit = config.productLimit,
        phases = config.phases,
        categoryUrl = null,    // ✅ NEW
        maxProducts = null,    // ✅ NEW
        maxPages = null        // ✅ NEW
    } = options;

    const executionId = uuidv4();
    const startTime = new Date();

    // ✅ 통합 로그 파일 생성
    const unifiedLogPath = createUnifiedLogPath();
    writeUnifiedLog(unifiedLogPath, '═══════════════════════════════════════════════════════════════════════');
    writeUnifiedLog(unifiedLogPath, '🎬 파이프라인 실행 시작');
    writeUnifiedLog(unifiedLogPath, `📋 제품 수: ${productLimit}개`);
    writeUnifiedLog(unifiedLogPath, `📁 통합 로그: ${path.basename(unifiedLogPath)}`);
    writeUnifiedLog(unifiedLogPath, '═══════════════════════════════════════════════════════════════════════');

    systemState = {
        status: 'running',
        currentPhase: null,
        currentProduct: 0,
        totalProducts: productLimit,
        startTime: startTime.toISOString(),
        pausedAt: null,
        errors: [],
        stats: {
            totalProcessed: 0,
            successCount: 0,
            failedCount: 0,
            apiCalls: 0,
            estimatedCost: 0
        },
        unifiedLogPath: unifiedLogPath  // ✅ 통합 로그 경로 저장
    };

    io.emit('state', systemState);
    addLog('info', `🎬 파이프라인 시작 (${productLimit}개 제품)`);
    
    // ✅ NEW: categoryUrl이 있으면 Phase 0 먼저 실행
    if (categoryUrl && phases.phase0) {
        try {
            systemState.currentPhase = 'phase0';
            io.emit('state', systemState);
            
            addLog('info', `📂 새 URL에서 제품 수집: ${categoryUrl.substring(0, 60)}...`);
            await runPhase0(categoryUrl, maxProducts || productLimit, 'URL 수집', maxPages || 0);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            addLog('error', `❌ Phase 0 실패: ${error.message}`);
            
            // Phase 0 실패 시 전체 파이프라인 중단 여부 결정
            systemState.status = 'error';
            io.emit('state', systemState);
            return { success: false, error: error.message };
        }
    }
    
    // Phase 1~5만 필터링 (Phase 0 이미 처리됨 또는 제외)
    const pipelinePhases = PHASES.filter(p => p.id !== 'phase0');
    const enabledPhases = pipelinePhases.filter(p => phases[p.id]);
    
    try {
        for (const phase of enabledPhases) {
            if (isPaused) {
                systemState.status = 'paused';
                systemState.pausedAt = new Date().toISOString();
                io.emit('state', systemState);
                addLog('warning', '⏸️ 파이프라인 일시정지됨');
                
                await new Promise((resolve) => {
                    const checkPause = setInterval(() => {
                        if (!isPaused) {
                            clearInterval(checkPause);
                            resolve();
                        }
                    }, 1000);
                });
                
                systemState.status = 'running';
                systemState.pausedAt = null;
                io.emit('state', systemState);
                addLog('info', '▶️ 파이프라인 재개됨');
            }
            
            systemState.currentPhase = phase.id;
            io.emit('state', systemState);

            // ✅ 통합 로그에 Phase 시작 기록
            writeUnifiedLog(unifiedLogPath, '');
            writeUnifiedLog(unifiedLogPath, `═══ ${phase.name.toUpperCase()} 시작 ═══`);

            await runPhase(phase, productLimit, null, null, null, unifiedLogPath);

            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const endTime = new Date();
        const duration = Math.round((endTime - startTime) / 1000);
        
        systemState.status = 'idle';
        systemState.currentPhase = null;
        systemState.stats.totalProcessed = productLimit;
        io.emit('state', systemState);
        
        addLog('success', `🎉 파이프라인 완료! (소요 시간: ${Math.floor(duration / 60)}분 ${duration % 60}초)`);

        // ✅ 통합 로그에 완료 기록
        writeUnifiedLog(unifiedLogPath, '');
        writeUnifiedLog(unifiedLogPath, '═══════════════════════════════════════════════════════════════════════');
        writeUnifiedLog(unifiedLogPath, '🎉 파이프라인 완료!');
        writeUnifiedLog(unifiedLogPath, `⏱️  소요 시간: ${Math.floor(duration / 60)}분 ${duration % 60}초`);
        writeUnifiedLog(unifiedLogPath, `✅ 성공: ${systemState.stats.successCount}개`);
        writeUnifiedLog(unifiedLogPath, `❌ 실패: ${systemState.stats.failedCount}개`);
        writeUnifiedLog(unifiedLogPath, '═══════════════════════════════════════════════════════════════════════');

        addExecutionHistory({
            id: executionId,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            duration: duration,
            productLimit: productLimit,
            phases: enabledPhases.map(p => p.id),
            stats: { ...systemState.stats },
            errors: [...systemState.errors],
            status: 'completed'
        });
        
        return { success: true, duration, stats: systemState.stats };
        
    } catch (error) {
        const endTime = new Date();
        const duration = Math.round((endTime - startTime) / 1000);
        
        systemState.status = 'error';
        io.emit('state', systemState);
        
        addLog('error', `❌ 파이프라인 실패: ${error.message}`);
        
        addExecutionHistory({
            id: executionId,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            duration: duration,
            productLimit: productLimit,
            phases: enabledPhases.map(p => p.id),
            stats: { ...systemState.stats },
            errors: [...systemState.errors],
            status: 'failed',
            errorMessage: error.message
        });
        
        return { success: false, error: error.message, stats: systemState.stats };
    }
}

// ==================== 스케줄링 ====================
function setupSchedules() {
    scheduledJobs.forEach(job => job.stop());
    scheduledJobs = [];
    
    config.schedules.forEach(schedule => {
        if (!schedule.enabled) return;
        
        try {
            const job = cron.schedule(schedule.cron, async () => {
                addLog('info', `⏰ 스케줄 실행: ${schedule.name}`);
                await runPipeline({
                    productLimit: schedule.productLimit,
                    phases: schedule.phases || config.phases
                });
            });
            
            scheduledJobs.push(job);
            addLog('info', `📅 스케줄 등록: ${schedule.name} (${schedule.cron})`);
        } catch (error) {
            addLog('error', `❌ 스케줄 등록 실패: ${schedule.name} - ${error.message}`);
        }
    });
}

setupSchedules();

// ==================== NocoDB API ====================
async function getProductStats() {
    try {
        const oliveyoungResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { limit: 1, offset: 0 }
            }
        );
        
        const shopifyResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { limit: 1, offset: 0 }
            }
        );
        
        const completedResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    limit: 1,
                    where: '(main_image,notnull)'
                }
            }
        );
        
        return {
            totalProducts: oliveyoungResponse.data.pageInfo?.totalRows || 0,
            shopifyProducts: shopifyResponse.data.pageInfo?.totalRows || 0,
            completedProducts: completedResponse.data.pageInfo?.totalRows || 0
        };
    } catch (error) {
        console.error('❌ 통계 조회 실패:', error.message);
        return {
            totalProducts: 0,
            shopifyProducts: 0,
            completedProducts: 0
        };
    }
}

async function getRecentProducts(limit = 10) {
    try {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    limit: limit,
                    sort: '-made_at',
                    where: '(main_image,notnull)'
                }
            }
        );
        
        return response.data.list.map(product => {
            const mainImageUrl = getImageUrl(product.main_image);
            
            return {
                id: product.Id,
                title: product.title_en || product.title_kr || `제품 #${product.Id}`,
                mainImage: mainImageUrl,
                galleryImages: product.gallery_images?.length || 0,
                madeAt: product.made_at,
                priceAud: product.price_aud
            };
        });
    } catch (error) {
        console.error('❌ 최근 제품 조회 실패:', error.message);
        return [];
    }
}

async function getFailedProducts() {
    try {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    limit: 50,
                    where: '(validated_images,notnull)~and(main_image,null)'
                }
            }
        );
        
        return response.data.list.map(product => ({
            id: product.Id,
            title: product.title_en || product.title_kr || `제품 #${product.Id}`,
            validatedImages: product.validated_images?.length || 0
        }));
    } catch (error) {
        console.error('❌ 실패 제품 조회 실패:', error.message);
        return [];
    }
}

// ==================== API 라우트 ====================

// 상태 조회
app.get('/api/state', (req, res) => {
    res.json(systemState);
});

// 설정 조회
app.get('/api/config', (req, res) => {
    res.json(config);
});

// 설정 저장
app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    saveConfig();
    setupSchedules();
    res.json({ success: true, config });
});

// ✅ 수정: 파이프라인 실행 - categoryUrl 파라미터 추가
app.post('/api/pipeline/start', async (req, res) => {
    if (systemState.status === 'running') {
        return res.status(400).json({ error: '이미 실행 중입니다' });
    }
    
    const { productLimit, phases, categoryUrl, maxProducts, maxPages } = req.body;
    
    // ✅ URL 유효성 검사
    if (categoryUrl && !categoryUrl.includes('oliveyoung.co.kr')) {
        return res.status(400).json({ error: '올리브영 URL이 아닙니다' });
    }
    
    res.json({ success: true, message: '파이프라인 시작됨' });
    
    runPipeline({
        productLimit: productLimit || config.productLimit,
        phases: phases || config.phases,
        categoryUrl: categoryUrl || null,      // ✅ NEW
        maxProducts: maxProducts || null,      // ✅ NEW
        maxPages: maxPages || null             // ✅ NEW
    });
});

// 파이프라인 일시정지
app.post('/api/pipeline/pause', (req, res) => {
    if (systemState.status !== 'running') {
        return res.status(400).json({ error: '실행 중이 아닙니다' });
    }
    
    isPaused = true;
    res.json({ success: true, message: '일시정지 요청됨' });
});

// 파이프라인 재개
app.post('/api/pipeline/resume', (req, res) => {
    if (systemState.status !== 'paused') {
        return res.status(400).json({ error: '일시정지 상태가 아닙니다' });
    }
    
    isPaused = false;
    res.json({ success: true, message: '재개됨' });
});

// 파이프라인 중지
app.post('/api/pipeline/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill('SIGTERM');
        currentProcess = null;
    }
    
    isPaused = false;
    systemState.status = 'idle';
    systemState.currentPhase = null;
    io.emit('state', systemState);
    
    addLog('warning', '🛑 파이프라인 강제 중지됨');
    
    res.json({ success: true, message: '중지됨' });
});

// ✅ 수정: 단일 Phase 실행 - categoryUrl 파라미터 추가
app.post('/api/pipeline/run-phase', async (req, res) => {
    if (systemState.status === 'running') {
        return res.status(400).json({ error: '이미 실행 중입니다' });
    }
    
    const { phaseId, productLimit, categoryUrl, maxProducts, maxPages } = req.body;
    const phase = PHASES.find(p => p.id === phaseId);
    
    if (!phase) {
        return res.status(400).json({ error: '유효하지 않은 Phase' });
    }
    
    // ✅ Phase 0인 경우 URL 필수 체크
    if (phaseId === 'phase0') {
        if (!categoryUrl) {
            return res.status(400).json({ error: 'Phase 0 실행에는 카테고리 URL이 필요합니다' });
        }
        if (!categoryUrl.includes('oliveyoung.co.kr')) {
            return res.status(400).json({ error: '올리브영 URL이 아닙니다' });
        }
    }
    
    res.json({ success: true, message: `${phase.name} 시작됨` });
    
    systemState.status = 'running';
    systemState.currentPhase = phaseId;
    io.emit('state', systemState);
    
    try {
        // ✅ Phase 0인 경우 runPhase0 사용, 그 외에는 runPhase 사용
        if (phaseId === 'phase0') {
            await runPhase0(categoryUrl, maxProducts || productLimit || config.productLimit, 'URL 수집', maxPages || 0);
        } else {
            await runPhase(phase, productLimit || config.productLimit);
        }
        
        systemState.status = 'idle';
        systemState.currentPhase = null;
        io.emit('state', systemState);
    } catch (error) {
        systemState.status = 'error';
        io.emit('state', systemState);
    }
});

// 로그 조회
app.get('/api/logs', (req, res) => {
    const { limit = 100, phase, type } = req.query;
    
    let filteredLogs = [...logs];
    
    if (phase) {
        filteredLogs = filteredLogs.filter(l => l.phase === phase);
    }
    
    if (type) {
        filteredLogs = filteredLogs.filter(l => l.type === type);
    }
    
    res.json(filteredLogs.slice(-parseInt(limit)));
});

// 실행 이력
app.get('/api/history', (req, res) => {
    res.json(executionHistory);
});

// 통계
app.get('/api/stats', async (req, res) => {
    const dbStats = await getProductStats();
    
    res.json({
        database: dbStats,
        current: systemState.stats,
        history: {
            totalExecutions: executionHistory.length,
            successfulExecutions: executionHistory.filter(e => e.status === 'completed').length,
            failedExecutions: executionHistory.filter(e => e.status === 'failed').length,
            totalApiCalls: executionHistory.reduce((sum, e) => sum + (e.stats?.apiCalls || 0), 0),
            totalCost: executionHistory.reduce((sum, e) => sum + (e.stats?.estimatedCost || 0), 0)
        }
    });
});

// 최근 처리된 제품
app.get('/api/products/recent', async (req, res) => {
    const { limit = 10 } = req.query;
    const products = await getRecentProducts(parseInt(limit));
    res.json(products);
});

// 실패한 제품
app.get('/api/products/failed', async (req, res) => {
    const products = await getFailedProducts();
    res.json(products);
});

// 실패 제품 재처리
app.post('/api/products/retry', async (req, res) => {
    const { productIds } = req.body;
    
    if (!productIds || productIds.length === 0) {
        return res.status(400).json({ error: '제품 ID가 필요합니다' });
    }
    
    res.json({ success: true, message: `${productIds.length}개 제품 재처리 예정` });
});

// 스케줄 목록
app.get('/api/schedules', (req, res) => {
    res.json(config.schedules || []);
});

// 스케줄 추가
app.post('/api/schedules', (req, res) => {
    const schedule = {
        id: uuidv4(),
        ...req.body,
        createdAt: new Date().toISOString()
    };
    
    config.schedules = config.schedules || [];
    config.schedules.push(schedule);
    saveConfig();
    setupSchedules();
    
    res.json({ success: true, schedule });
});

// 스케줄 삭제
app.delete('/api/schedules/:id', (req, res) => {
    const { id } = req.params;
    config.schedules = config.schedules.filter(s => s.id !== id);
    saveConfig();
    setupSchedules();
    
    res.json({ success: true });
});

// 스케줄 토글
app.patch('/api/schedules/:id/toggle', (req, res) => {
    const { id } = req.params;
    const schedule = config.schedules.find(s => s.id === id);
    
    if (schedule) {
        schedule.enabled = !schedule.enabled;
        saveConfig();
        setupSchedules();
        res.json({ success: true, enabled: schedule.enabled });
    } else {
        res.status(404).json({ error: '스케줄을 찾을 수 없습니다' });
    }
});

// Phase 목록
app.get('/api/phases', (req, res) => {
    res.json(PHASES);
});

// 디버그용: 이미지 URL 확인
app.get('/api/debug/image/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    where: `(Id,eq,${id})`
                }
            }
        );
        
        if (response.data.list.length > 0) {
            const product = response.data.list[0];
            res.json({
                id: product.Id,
                main_image_raw: product.main_image,
                main_image_url: getImageUrl(product.main_image),
                gallery_images_raw: product.gallery_images
            });
        } else {
            res.status(404).json({ error: '제품 없음' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== URL 큐 API ====================

// URL 큐 조회
app.get('/api/url-queue', (req, res) => {
    res.json(urlQueue);
});

// 카테고리 추가 (✅ maxPages: 0 = 무제한, null/undefined = 무제한)
app.post('/api/url-queue/category', (req, res) => {
    const { url, name, maxProducts = 100, maxPages = 0, limitPages = false } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL이 필요합니다' });
    }
    
    if (!url.includes('oliveyoung.co.kr')) {
        return res.status(400).json({ error: '올리브영 URL이 아닙니다' });
    }
    
    // ✅ limitPages가 false면 maxPages를 0으로 (무제한)
    const finalMaxPages = limitPages ? (parseInt(maxPages) || 10) : 0;
    
    const category = {
        id: uuidv4(),
        url: url.trim(),
        name: name?.trim() || '이름 없음',
        maxProducts: parseInt(maxProducts) || 100,
        maxPages: finalMaxPages,  // ✅ 0 = 무제한
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    
    urlQueue.categories.push(category);
    saveUrlQueue();
    
    io.emit('urlQueue', urlQueue);
    const pagesText = finalMaxPages === 0 ? '무제한' : `${finalMaxPages}페이지`;
    addLog('info', `📂 카테고리 추가됨: ${category.name} (최대 ${category.maxProducts}개, ${pagesText})`);
    
    res.json({ success: true, category });
});

// 카테고리 삭제
app.delete('/api/url-queue/category/:id', (req, res) => {
    const { id } = req.params;
    
    const index = urlQueue.categories.findIndex(c => c.id === id);
    if (index === -1) {
        return res.status(404).json({ error: '카테고리를 찾을 수 없습니다' });
    }
    
    const removed = urlQueue.categories.splice(index, 1)[0];
    saveUrlQueue();
    
    io.emit('urlQueue', urlQueue);
    addLog('info', `🗑️ 카테고리 삭제됨: ${removed.name}`);
    
    res.json({ success: true });
});

// 카테고리 상태 초기화
app.patch('/api/url-queue/category/:id/reset', (req, res) => {
    const { id } = req.params;
    
    const category = urlQueue.categories.find(c => c.id === id);
    if (!category) {
        return res.status(404).json({ error: '카테고리를 찾을 수 없습니다' });
    }
    
    category.status = 'pending';
    delete category.completedAt;
    delete category.error;
    saveUrlQueue();
    
    io.emit('urlQueue', urlQueue);
    
    res.json({ success: true, category });
});

// 완료된 항목 삭제
app.delete('/api/url-queue/completed', (req, res) => {
    const before = urlQueue.categories.length;
    urlQueue.categories = urlQueue.categories.filter(c => c.status !== 'completed');
    const removed = before - urlQueue.categories.length;
    
    saveUrlQueue();
    io.emit('urlQueue', urlQueue);
    
    res.json({ success: true, removed });
});

// URL 큐 실행 (Phase 0만)
app.post('/api/url-queue/process', async (req, res) => {
    try {
        if (systemState.status === 'running') {
            return res.status(400).json({ error: '이미 실행 중입니다' });
        }
        
        res.json({ success: true, message: 'URL 큐 처리 시작됨' });
        
        processUrlQueue().catch(error => {
            addLog('error', `❌ URL 큐 처리 실패: ${error.message}`);
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// URL 큐 + 파이프라인 통합 실행
app.post('/api/url-queue/process-full', async (req, res) => {
    try {
        if (systemState.status === 'running') {
            return res.status(400).json({ error: '이미 실행 중입니다' });
        }
        
        const { phases = config.phases } = req.body;
        
        res.json({ success: true, message: 'URL 수집 + 파이프라인 시작됨' });
        
        (async () => {
            try {
                const queueResult = await processUrlQueue();
                
                if (queueResult.success && queueResult.totalCollected > 0) {
                    addLog('info', '🔄 URL 수집 완료, 파이프라인 시작...');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    await runPipeline({
                        productLimit: queueResult.totalCollected,
                        phases: phases
                    });
                }
            } catch (error) {
                addLog('error', `❌ 통합 실행 실패: ${error.message}`);
            }
        })();
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 개별 제품 URL 추가
app.post('/api/url-queue/product', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL이 필요합니다' });
    }
    
    if (!url.includes('oliveyoung.co.kr') || !url.includes('goodsNo=')) {
        return res.status(400).json({ error: '올리브영 제품 URL이 아닙니다' });
    }
    
    const goodsNoMatch = url.match(/goodsNo=([A-Z0-9]+)/);
    if (!goodsNoMatch) {
        return res.status(400).json({ error: '유효하지 않은 제품 URL입니다' });
    }
    
    const goodsNo = goodsNoMatch[1];
    const cleanUrl = `https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${goodsNo}`;
    
    try {
        // ✅ SKU 중복 체크
        const existingCheck = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    where: `(sku,eq,${goodsNo})`,
                    limit: 1
                }
            }
        );
        
        if (existingCheck.data.list.length > 0) {
            return res.status(400).json({ error: `이미 등록된 SKU입니다: ${goodsNo}` });
        }
        
        const productData = {
            sku: goodsNo,
            product_url: cleanUrl,
            collected_at: new Date().toISOString()
        };
        
        const response = await axios.post(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            productData,
            {
                headers: { 
                    'xc-token': NOCODB_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        addLog('success', `📦 제품 URL 추가됨: ${goodsNo}`);
        res.json({ success: true, productId: response.data.Id, sku: goodsNo });
        
    } catch (error) {
        if (error.response?.status === 422) {
            return res.status(400).json({ error: '이미 등록된 URL입니다' });
        }
        res.status(500).json({ error: error.message });
    }
});

// 올리브영 제품 목록 조회
app.get('/api/oliveyoung/products', async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    sort: '-collected_at'
                }
            }
        );
        
        res.json({
            list: response.data.list,
            total: response.data.pageInfo?.totalRows || 0
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 올리브영 제품 삭제
app.delete('/api/oliveyoung/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await axios.delete(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                data: { Id: parseInt(id) }
            }
        );
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== 로그 파일 API ====================
// 이 코드를 server.js의 API 라우트 섹션에 추가하세요
// (// ==================== 강제 종료 API ==================== 위에 추가)

const LOGS_DIR = path.join(SCRIPTS_DIR, 'logs');

// 유틸리티 함수
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDateTime(date) {
    const d = new Date(date);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
}

// 로그 파일 목록 조회
app.get('/api/logs/files', (req, res) => {
    try {
        if (!fs.existsSync(LOGS_DIR)) {
            return res.json({ files: {}, latestFile: null, totalFiles: 0 });
        }
        
        const allFiles = fs.readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.log'))
            .map(f => {
                const filePath = path.join(LOGS_DIR, f);
                const stats = fs.statSync(filePath);
                return {
                    name: f,
                    size: stats.size,
                    sizeFormatted: formatFileSize(stats.size),
                    modifiedAt: stats.mtime.toISOString(),
                    modifiedAtFormatted: formatDateTime(stats.mtime)
                };
            })
            .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
        
        // Phase별로 그룹화 (+ pipeline 통합 로그 추가)
        const grouped = {
            pipeline: [],  // ✅ 통합 로그 그룹 추가
            phase0: [],
            phase1: [],
            phase2: [],
            phase3: [],
            phase4: [],
            phase5: []
        };

        allFiles.forEach(file => {
            // ✅ pipeline 로그 먼저 체크
            if (file.name.startsWith('pipeline_')) {
                grouped.pipeline.push(file);
            } else {
                const match = file.name.match(/^phase(\d)/);
                if (match) {
                    const phase = `phase${match[1]}`;
                    if (grouped[phase]) {
                        grouped[phase].push(file);
                    }
                }
            }
        });
        
        res.json({
            files: grouped,
            latestFile: allFiles.length > 0 ? allFiles[0].name : null,
            totalFiles: allFiles.length
        });
        
    } catch (error) {
        console.error('로그 파일 목록 조회 실패:', error);
        res.status(500).json({ error: error.message });
    }
});

// 특정 로그 파일 내용 조회
app.get('/api/logs/file/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        const { filter = 'all', lines: maxLines = 2000 } = req.query;
        
        // 보안: 경로 탐색 방지
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: '잘못된 파일명' });
        }
        
        const filePath = path.join(LOGS_DIR, filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '파일을 찾을 수 없습니다' });
        }
        
        const stats = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        let lines = content.split('\n').filter(l => l.trim());
        
        // 필터 적용
        if (filter === 'summary') {
            lines = lines.filter(l => 
                l.includes('결과') || l.includes('완료') || l.includes('실패') ||
                l.includes('🎉') || l.includes('✅') || l.includes('❌') ||
                l.includes('성공:') || l.includes('총') || l.includes('📊') ||
                l.includes('시작') || l.includes('종료')
            );
        } else if (filter === 'errors') {
            lines = lines.filter(l => 
                l.includes('❌') || l.includes('실패') || l.includes('오류') || 
                l.includes('Error') || l.includes('error') || l.includes('Exception')
            );
        }
        
        // 최대 줄 수 제한
        const limitedLines = lines.slice(-parseInt(maxLines));
        
        res.json({
            filename,
            size: stats.size,
            modifiedAt: formatDateTime(stats.mtime),
            totalLines: lines.length,
            lines: limitedLines,
            content: limitedLines.join('\n')
        });
        
    } catch (error) {
        console.error('로그 파일 조회 실패:', error);
        res.status(500).json({ error: error.message });
    }
});

// 전체 로그 요약
app.get('/api/logs/summary', (req, res) => {
    try {
        if (!fs.existsSync(LOGS_DIR)) {
            return res.json({ phases: {} });
        }

        // ✅ pipeline 통합 로그 그룹 추가
        const phases = ['pipeline', 'phase0', 'phase1', 'phase2', 'phase3', 'phase4', 'phase5'];
        const result = {};

        phases.forEach(phase => {
            const phaseFiles = fs.readdirSync(LOGS_DIR)
                .filter(f => f.startsWith(phase) && f.endsWith('.log'))
                .map(f => {
                    const filePath = path.join(LOGS_DIR, f);
                    const stats = fs.statSync(filePath);
                    return { name: f, mtime: stats.mtime };
                })
                .sort((a, b) => b.mtime - a.mtime);
            
            if (phaseFiles.length === 0) {
                result[phase] = {
                    latestFile: null,
                    modifiedAt: null,
                    summary: ['로그 파일 없음'],
                    hasErrors: false,
                    hasWarnings: false,
                    totalFiles: 0
                };
                return;
            }
            
            // 가장 최근 파일 분석
            const latestFile = phaseFiles[0];
            const filePath = path.join(LOGS_DIR, latestFile.name);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            
            // 요약 추출 (결과/완료 부분)
            const summaryLines = [];
            let hasErrors = false;
            let hasWarnings = false;
            
            // 역순으로 검색하여 결과 부분 찾기
            for (let i = lines.length - 1; i >= 0 && summaryLines.length < 10; i--) {
                const line = lines[i].trim();
                if (!line) continue;
                
                // 결과/완료/통계 관련 줄 수집
                if (line.includes('🎉') || line.includes('결과') || line.includes('완료') ||
                    line.includes('성공:') || line.includes('실패:') || line.includes('총') ||
                    line.includes('📊') || line.includes('처리') || line.includes('수집') ||
                    (line.includes('✅') && (line.includes('개') || line.includes('완료'))) ||
                    (line.includes('❌') && (line.includes('개') || line.includes('실패')))) {
                    summaryLines.unshift(line);
                }
                
                if (line.includes('❌') || line.includes('실패') || line.includes('Error')) {
                    hasErrors = true;
                }
                if (line.includes('⚠️') || line.includes('경고') || line.includes('스킵')) {
                    hasWarnings = true;
                }
            }
            
            result[phase] = {
                latestFile: latestFile.name,
                modifiedAt: formatDateTime(latestFile.mtime),
                summary: summaryLines.length > 0 ? summaryLines : ['요약 정보 없음'],
                hasErrors,
                hasWarnings,
                totalFiles: phaseFiles.length
            };
        });
        
        res.json({ phases: result });
        
    } catch (error) {
        console.error('로그 요약 조회 실패:', error);
        res.status(500).json({ error: error.message });
    }
});

// 특정 Phase 최신 로그 요약
app.get('/api/logs/summary/:phase', (req, res) => {
    try {
        const { phase } = req.params;

        // ✅ pipeline 그룹 추가
        if (!['pipeline', 'phase0', 'phase1', 'phase2', 'phase3', 'phase4', 'phase5'].includes(phase)) {
            return res.status(400).json({ error: '유효하지 않은 Phase' });
        }
        
        if (!fs.existsSync(LOGS_DIR)) {
            return res.json({ summary: [], latestFile: null });
        }
        
        const phaseFiles = fs.readdirSync(LOGS_DIR)
            .filter(f => f.startsWith(phase) && f.endsWith('.log'))
            .map(f => {
                const filePath = path.join(LOGS_DIR, f);
                const stats = fs.statSync(filePath);
                return { name: f, mtime: stats.mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
        
        if (phaseFiles.length === 0) {
            return res.json({ summary: ['로그 파일 없음'], latestFile: null });
        }
        
        const latestFile = phaseFiles[0];
        const filePath = path.join(LOGS_DIR, latestFile.name);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        
        // 핵심 요약만 추출
        const summaryLines = lines.filter(l => 
            l.includes('🎉') || l.includes('결과') || l.includes('완료') ||
            l.includes('성공:') || l.includes('실패:') || l.includes('📊') ||
            (l.includes('✅') && l.includes('개')) || (l.includes('❌') && l.includes('개'))
        ).slice(-15);
        
        res.json({
            phase,
            latestFile: latestFile.name,
            modifiedAt: formatDateTime(latestFile.mtime),
            summary: summaryLines,
            totalLines: lines.length,
            totalFiles: phaseFiles.length
        });
        
    } catch (error) {
        console.error('Phase 로그 요약 조회 실패:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== 강제 종료 API ==================== ✅ 추가됨!
app.post('/api/force-kill', async (req, res) => {
    console.log('🛑 강제 종료 요청됨...');
    addLog('warning', '🔴 강제 종료 요청됨...');
    
    const results = { message: [] };
    
    // 1. 현재 프로세스 종료
    if (currentProcess) {
        try {
            currentProcess.kill('SIGKILL');
            currentProcess = null;
            results.message.push('✅ 현재 프로세스 종료됨');
        } catch (e) {
            results.message.push('⚠️ 현재 프로세스 종료 실패: ' + e.message);
        }
    }
    
    // 2. Phase 관련 node 프로세스 종료
    try {
        execSync('pkill -f "node phase" 2>/dev/null || true', { timeout: 5000 });
        results.message.push('✅ Phase 프로세스 종료됨');
    } catch (e) {
        results.message.push('⚠️ Phase 프로세스 없거나 종료 실패');
    }
    
    // 3. Chromium/Playwright 종료
    try {
        execSync('pkill -f chromium 2>/dev/null || true', { timeout: 5000 });
        results.message.push('✅ Chromium 프로세스 종료됨');
    } catch (e) {
        results.message.push('⚠️ Chromium 프로세스 없거나 종료 실패');
    }
    
    // 4. 상태 초기화
    isPaused = false;
    systemState.status = 'idle';
    systemState.currentPhase = null;
    io.emit('state', systemState);
    
    addLog('success', '🛑 강제 종료 완료!');
    console.log('🛑 강제 종료 완료:', results.message.join(', '));
    
    res.json({ success: true, message: results.message.join('\n') });
});

// ==================== Socket.io ====================
io.on('connection', (socket) => {
    console.log('🔌 클라이언트 연결됨:', socket.id);
    
    socket.emit('state', systemState);
    socket.emit('logs', logs.slice(-100));
    socket.emit('urlQueue', urlQueue);
    
    socket.on('disconnect', () => {
        console.log('🔌 클라이언트 연결 해제:', socket.id);
    });
});

// ==================== 서버 시작 ====================
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('🚀 Copychu Dashboard 서버 시작!');
    console.log('='.repeat(60));
    console.log(`📡 주소: http://localhost:${PORT}`);
    console.log(`📡 외부 접속: http://77.42.67.165:${PORT}`);
    console.log(`📂 스크립트 경로: ${SCRIPTS_DIR}`);
    console.log('='.repeat(60));
    console.log('\n📋 사용 가능한 Phase:');
    PHASES.forEach(p => console.log(`   - ${p.name}`));
    console.log('\n🔗 URL 큐 API:');
    console.log('   - GET  /api/url-queue');
    console.log('   - POST /api/url-queue/category');
    console.log('   - POST /api/url-queue/process');
    console.log('   - POST /api/url-queue/process-full');
    console.log('   - POST /api/force-kill  ← 🆕 강제 종료');
    console.log('='.repeat(60));
});
// ==================== Graceful Shutdown ====================
function gracefulShutdown(signal) {
    console.log(`\n⚠️ ${signal} 수신 - 서버 종료 중...`);
    
    // 1. 실행 중인 프로세스 종료
    if (currentProcess) {
        try {
            currentProcess.kill('SIGTERM');
            currentProcess = null;
            console.log('✅ 현재 프로세스 종료됨');
        } catch (e) {
            console.log('⚠️ 프로세스 종료 실패:', e.message);
        }
    }
    
    // 2. 모든 소켓 연결 종료
    io.close(() => {
        console.log('✅ Socket.io 연결 종료됨');
    });
    
    // 3. HTTP 서버 종료
    httpServer.close(() => {
        console.log('✅ HTTP 서버 종료됨');
        console.log('👋 서버 완전히 종료됨');
        process.exit(0);
    });
    
    // 4. 5초 후 강제 종료 (안전장치)
    setTimeout(() => {
        console.log('⚠️ 강제 종료 (타임아웃)');
        process.exit(1);
    }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    gracefulShutdown('uncaughtException');
});