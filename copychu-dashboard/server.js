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
        phase2_5: true,
        phase2_6: true
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

// ==================== 로그 관리 ====================
const logs = [];
const MAX_LOGS = 1000;

function addLog(type, message, phase = null) {
    const log = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
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
    
    // 배열인 경우 첫 번째 요소 사용
    const img = Array.isArray(imageData) ? imageData[0] : imageData;
    if (!img) return null;
    
    // url이 완전한 URL인 경우
    if (img.url && img.url.startsWith('http')) {
        return img.url;
    }
    
    // signedPath가 있는 경우
    if (img.signedPath) {
        return `${NOCODB_API_URL}/${img.signedPath}`;
    }
    
    // path가 있는 경우
    if (img.path) {
        return `${NOCODB_API_URL}/${img.path}`;
    }
    
    // url이 상대 경로인 경우
    if (img.url) {
        return `${NOCODB_API_URL}/${img.url}`;
    }
    
    return null;
}

// ==================== 파이프라인 실행 ====================
const PHASES = [
    { id: 'phase1', name: 'Phase 1: 스크래핑', script: 'phase1-main-gallery.js' },
    { id: 'phase2', name: 'Phase 2: 배경 제거', script: 'phase2-ai-generate.js' },
    { id: 'phase3', name: 'Phase 3: AI 크롭', script: 'phase3-multi-3products.js' },
    { id: 'phase4', name: 'Phase 4: 이미지 선별', script: 'phase4-final-data.js' }
];

async function runPhase(phase, productLimit) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPTS_DIR, phase.script);
        
        // 스크립트 파일 존재 확인
        if (!fs.existsSync(scriptPath)) {
            addLog('error', `❌ 스크립트 파일 없음: ${scriptPath}`, phase.id);
            reject(new Error(`Script not found: ${scriptPath}`));
            return;
        }
        
        addLog('info', `🚀 ${phase.name} 시작 (${productLimit}개 제품)`, phase.id);
        
        // 환경 변수로 limit 전달
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
                // 진행 상황 파싱
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
                
                // API 호출 감지
                if (line.includes('Gemini') || line.includes('API')) {
                    systemState.stats.apiCalls++;
                    // Gemini 2.0 Flash 비용: $0.0001/이미지
                    systemState.stats.estimatedCost = systemState.stats.apiCalls * 0.0001;
                }
                
                // 성공/실패 감지
                if (line.includes('✅') || line.includes('성공')) {
                    systemState.stats.successCount++;
                }
                if (line.includes('❌') || line.includes('실패')) {
                    systemState.stats.failedCount++;
                }
                
                // 로그 타입 결정
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
    
    const enabledPhases = PHASES.filter(p => phases[p.id]);
    
    try {
        for (const phase of enabledPhases) {
            if (isPaused) {
                systemState.status = 'paused';
                systemState.pausedAt = new Date().toISOString();
                io.emit('state', systemState);
                addLog('warning', '⏸️ 파이프라인 일시정지됨');
                
                // 재개될 때까지 대기
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
            
            // 단계 사이 대기
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const endTime = new Date();
        const duration = Math.round((endTime - startTime) / 1000);
        
        systemState.status = 'idle';
        systemState.currentPhase = null;
        systemState.stats.totalProcessed = productLimit;
        io.emit('state', systemState);
        
        addLog('success', `🎉 파이프라인 완료! (소요 시간: ${Math.floor(duration / 60)}분 ${duration % 60}초)`);
        
        // 실행 이력 추가
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
        
        // 실행 이력 추가
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
    // 기존 스케줄 제거
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
        // 올리브영 테이블 통계
        const oliveyoungResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { limit: 1, offset: 0 }
            }
        );
        
        // Shopify 테이블 통계
        const shopifyResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { limit: 1, offset: 0 }
            }
        );
        
        // 처리 완료된 제품 수 (main_image가 있는 것)
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

// ✅ 수정된 함수: 이미지 URL 제대로 처리
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
            // ✅ 이미지 URL 처리 개선
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
        // validated_images는 있지만 main_image가 없는 제품
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
    
    // 비동기로 실행
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
    
    // TODO: 특정 제품만 재처리하는 로직 구현
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

// ✅ 디버그용: 이미지 URL 확인
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

// ==================== Socket.io ====================
io.on('connection', (socket) => {
    console.log('🔌 클라이언트 연결됨:', socket.id);
    
    // 현재 상태 전송
    socket.emit('state', systemState);
    socket.emit('logs', logs.slice(-100));
    
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
});