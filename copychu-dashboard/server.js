import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn } from 'child_process';
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
    schedules: [],
    phases: {
        phase1: true,
        phase2: true,
        phase3: true,
        phase4: true
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
    { id: 'phase4', name: 'Phase 4: 이미지 선별', script: 'phase4-final-data.js' }
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

// ==================== 파이프라인 실행 ====================
async function runPhase(phase, productLimit) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPTS_DIR, phase.script);
        
        if (!fs.existsSync(scriptPath)) {
            addLog('error', `❌ 스크립트 파일 없음: ${scriptPath}`, phase.id);
            reject(new Error(`Script not found: ${scriptPath}`));
            return;
        }
        
        addLog('info', `🚀 ${phase.name} 시작 (${productLimit}개 제품)`, phase.id);
        
        const env = {
            ...process.env,
            PRODUCT_LIMIT: productLimit.toString()
        };
        
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

async function runPipeline(options = {}) {
    const { productLimit = config.productLimit, phases = config.phases } = options;
    
    const executionId = uuidv4();
    const startTime = new Date();
    
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
        }
    };
    
    io.emit('state', systemState);
    addLog('info', `🎬 파이프라인 시작 (${productLimit}개 제품)`);
    
    // Phase 1~4만 필터링 (Phase 0 제외)
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
            
            await runPhase(phase, productLimit);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const endTime = new Date();
        const duration = Math.round((endTime - startTime) / 1000);
        
        systemState.status = 'idle';
        systemState.currentPhase = null;
        systemState.stats.totalProcessed = productLimit;
        io.emit('state', systemState);
        
        addLog('success', `🎉 파이프라인 완료! (소요 시간: ${Math.floor(duration / 60)}분 ${duration % 60}초)`);
        
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

// 파이프라인 실행
app.post('/api/pipeline/start', async (req, res) => {
    if (systemState.status === 'running') {
        return res.status(400).json({ error: '이미 실행 중입니다' });
    }
    
    const { productLimit, phases } = req.body;
    
    res.json({ success: true, message: '파이프라인 시작됨' });
    
    runPipeline({
        productLimit: productLimit || config.productLimit,
        phases: phases || config.phases
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

// 단일 Phase 실행
app.post('/api/pipeline/run-phase', async (req, res) => {
    if (systemState.status === 'running') {
        return res.status(400).json({ error: '이미 실행 중입니다' });
    }
    
    const { phaseId, productLimit } = req.body;
    const phase = PHASES.find(p => p.id === phaseId);
    
    if (!phase) {
        return res.status(400).json({ error: '유효하지 않은 Phase' });
    }
    
    res.json({ success: true, message: `${phase.name} 시작됨` });
    
    systemState.status = 'running';
    systemState.currentPhase = phaseId;
    io.emit('state', systemState);
    
    try {
        await runPhase(phase, productLimit || config.productLimit);
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
    console.log('='.repeat(60));
});