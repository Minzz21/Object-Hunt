'use strict';

// ── Configuration ────────────────────────────────────────
const CFG = {
  totalRounds:   5,
  roundTime:     30,      // seconds
  countdownSecs: 3,
  apiIntervalMs: 1000,    // ms between API calls (alternating P1/P2)
  confThreshold: 0.50,
  flashDuration: 2200,    // ms
};

const OBJECT_POOL = [
  'book', 'laptop', 'keyboard', 'mouse', 'scissors',
  'backpack', 'cell phone', 'chair', 'clock', 'bottle',
  'cup', 'remote', 'umbrella', 'tie', 'tv',
];

// ── State ────────────────────────────────────────────────
const S = {
  phase: 'waiting',   // waiting|countdown|playing|round_end|game_over
  p1Score: 0,
  p2Score: 0,
  round: 0,
  target: '',
  usedObjects: [],

  roundStart:   0,    // timestamp (ms)
  cdStart:      0,
  roundEnd:     0,
  roundWinner:  0,    // 0=timeout 1=P1 2=P2
  gameWinner:   0,

  p1Results:    [],
  p2Results:    [],
  processingP1: false,
  processingP2: false,
  lastApiTime:  0,
  apiTurn:      1,    // whose turn to send frame

  p1FoundAt:    0,    // timestamp when P1 found object
  p2FoundAt:    0,
};

// ── DOM ──────────────────────────────────────────────────
const video       = document.getElementById('game-video');
const canvas      = document.getElementById('game-canvas');
const ctx         = canvas.getContext('2d');

const elRound     = document.getElementById('round-info');
const elTarget    = document.getElementById('target-name');
const elTimerVal  = document.getElementById('timer-value');
const elRingFg    = document.getElementById('ring-fg');
const elP1Score   = document.getElementById('p1-score');
const elP2Score   = document.getElementById('p2-score');
const elP1Flash   = document.getElementById('p1-flash');
const elP2Flash   = document.getElementById('p2-flash');
const elP1Dot     = document.getElementById('p1-dot');
const elP2Dot     = document.getElementById('p2-dot');

const RING_CIRC   = 2 * Math.PI * 19; // circumference of timer ring

// Screens
const SCR = {
  camera:    document.getElementById('screen-camera'),
  waiting:   document.getElementById('screen-waiting'),
  countdown: document.getElementById('screen-countdown'),
  roundEnd:  document.getElementById('screen-round-end'),
  gameOver:  document.getElementById('screen-game-over'),
};

// ── Camera Setup (2-step) ────────────────────────────────
let selectedDeviceId = null;   // device chosen by user
let previewStream    = null;   // stream used in preview <video>

async function setupCamera() {
  const btnAllow   = document.getElementById('btn-allow-cam');
  const btnConfirm = document.getElementById('btn-confirm-cam');
  const camSelect  = document.getElementById('cam-select');
  const preview    = document.getElementById('cam-preview');
  const errEl      = document.getElementById('cam-error');
  const stepAllow  = document.getElementById('cam-step-allow');
  const stepSelect = document.getElementById('cam-step-select');

  // ── Check: navigator.mediaDevices harus tersedia ──
  // Tidak tersedia jika: HTTP non-localhost, atau browser lama
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // Jika akses via 127.0.0.1, redirect otomatis ke localhost (secure context)
    if (location.hostname === '127.0.0.1') {
      location.href = location.href.replace('127.0.0.1', 'localhost');
      return;
    }
    // Jika bukan localhost sama sekali, tampilkan pesan
    btnAllow.disabled = true;
    errEl.style.whiteSpace = 'pre-line';
    errEl.textContent =
      '🔒 Browser memblokir akses kamera karena halaman tidak aman (HTTP).\n\n' +
      'Gunakan alamat ini:\n👉 http://localhost:5000\n\nbukan http://127.0.0.1:5000';
    return;
  }

  // ── Step 1: Request permission & enumerate devices ──
  btnAllow.addEventListener('click', async () => {
    btnAllow.disabled = true;
    btnAllow.textContent = 'Meminta izin...';
    errEl.textContent = '';
    try {
      // Trigger browser permission dialog
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tempStream.getTracks().forEach(t => t.stop()); // stop immediately, just needed for permission
      cameraPermissionGranted = true;

      // Enumerate video input devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');

      // Populate dropdown
      camSelect.innerHTML = '';
      videoDevices.forEach((dev, i) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Kamera ${i + 1}`;
        camSelect.appendChild(opt);
      });

      // Show step 2
      stepAllow.style.display = 'none';
      stepSelect.style.display = 'flex';

      // Start preview with first device
      await startPreview(videoDevices[0].deviceId);

    } catch (e) {
      btnAllow.disabled = false;
      btnAllow.textContent = '🎥 Coba Lagi';

      const msgs = {
        NotFoundError:
          '🔍 Kamera tidak ditemukan oleh browser.\n\nCek pengaturan privasi Windows:\n1. Buka: Start → Settings → Privacy & Security → Camera\n2. Pastikan "Camera access" → ON\n3. Pastikan "Let apps access your camera" → ON\n4. Scroll ke bawah, pastikan browser kamu (Edge/Chrome) → ON\n\nKemudian refresh halaman ini dan coba lagi.',
        DevicesNotFoundError:
          '🔍 Tidak ada kamera yang terdeteksi.\n\nCek Privacy Windows:\nStart → Settings → Privacy & Security → Camera → ON semua.',
        NotReadableError:
          '🔴 Kamera sedang dipakai aplikasi lain.\nTutup Python script, Zoom, Teams, OBS, atau kamera lain yang aktif, lalu klik Coba Lagi.',
        TrackStartError:
          '🔴 Kamera sedang dipakai aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.',
        NotAllowedError:
          '🔒 Izin kamera ditolak.\nKlik ikon 🔒 di address bar → Site settings → Camera → Allow, lalu refresh halaman.',
        PermissionDeniedError:
          '🔒 Izin kamera ditolak.\nKlik ikon 🔒 di address bar → Site settings → Camera → Allow, lalu refresh halaman.',
        OverconstrainedError:
          '⚠️ Resolusi tidak didukung kamera ini. Klik Coba Lagi.',
      };
      const msg = msgs[e.name] || `⚠️ ${e.name}: ${e.message}`;
      errEl.style.whiteSpace = 'pre-line';
      errEl.textContent = msg;
    }
  });

  // ── Switch preview when dropdown changes ──
  camSelect.addEventListener('change', () => startPreview(camSelect.value));

  // ── Step 2: Confirm selection ──
  btnConfirm.addEventListener('click', async () => {
    const deviceId = camSelect.value;
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Menghubungkan...';

    // Stop preview stream
    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }

    // Apply selected camera to the main game video
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await new Promise(r => { video.onloadedmetadata = r; });
      video.play();
      resizeCanvas();

      // Done — show waiting screen
      SCR.camera.classList.remove('active');
      SCR.waiting.classList.add('active');
      btnConfirm.disabled = false;
      btnConfirm.textContent = '✅ Gunakan Kamera Ini';
    } catch (e) {
      btnConfirm.disabled = false;
      btnConfirm.textContent = '✅ Gunakan Kamera Ini';
      document.getElementById('cam-error').style.whiteSpace = 'pre-line';
      document.getElementById('cam-error').textContent = '⚠️ Gagal membuka kamera: ' + e.message;
    }
  });
}

// ── Open camera selector (reusable, skips allow if already permitted) ──
let cameraPermissionGranted = false;

async function openCameraSelector() {
  const stepAllow  = document.getElementById('cam-step-allow');
  const stepSelect = document.getElementById('cam-step-select');
  const camSelect  = document.getElementById('cam-select');
  const errEl      = document.getElementById('cam-error');

  // Stop preview & current game stream
  if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }

  errEl.textContent = '';

  // Show camera screen over everything
  Object.values(SCR).forEach(s => s.classList.remove('active'));
  SCR.camera.classList.add('active');

  if (cameraPermissionGranted) {
    // Skip straight to device selection
    stepAllow.style.display  = 'none';
    stepSelect.style.display = 'flex';

    // Re-enumerate devices
    const devices      = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    camSelect.innerHTML = '';
    videoDevices.forEach((dev, i) => {
      const opt = document.createElement('option');
      opt.value       = dev.deviceId;
      opt.textContent = dev.label || `Kamera ${i + 1}`;
      // Mark currently active camera
      if (dev.deviceId === selectedDeviceId) opt.selected = true;
      camSelect.appendChild(opt);
    });

    // Start live preview
    await startPreview(camSelect.value);
  } else {
    // Show allow step
    stepAllow.style.display  = 'flex';
    stepSelect.style.display = 'none';
  }
}

async function startPreview(deviceId) {
  const preview = document.getElementById('cam-preview');
  if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); }
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 } },
      audio: false,
    });
    preview.srcObject = previewStream;
    selectedDeviceId = deviceId;
  } catch (e) {
    console.warn('Preview error:', e);
  }
}

function resizeCanvas() {
  const area = document.getElementById('game-area');
  canvas.width  = area.clientWidth;
  canvas.height = area.clientHeight;
}

// ── Game Logic ───────────────────────────────────────────
function pickTarget() {
  let pool = OBJECT_POOL.filter(o => !S.usedObjects.includes(o));
  if (!pool.length) { S.usedObjects = []; pool = [...OBJECT_POOL]; }
  const obj = pool[Math.floor(Math.random() * pool.length)];
  S.usedObjects.push(obj);
  return obj;
}

function showScreen(name) {
  Object.values(SCR).forEach(s => s.classList.remove('active'));
  if (name) SCR[name].classList.add('active');
}

function beginCountdown() {
  S.p1Results  = []; S.p2Results  = [];
  S.p1FoundAt  = 0;  S.p2FoundAt  = 0;
  S.target     = pickTarget();
  S.cdStart    = performance.now();
  S.phase      = 'countdown';

  document.getElementById('cd-target').textContent = S.target.toUpperCase();
  document.getElementById('cd-number').textContent = CFG.countdownSecs;
  showScreen('countdown');
}

function beginRound() {
  S.round++;
  S.roundStart = performance.now();
  S.phase      = 'playing';
  showScreen(null);

  elRound.textContent = `Round ${S.round} / ${CFG.totalRounds}`;
  elTarget.textContent = S.target.toUpperCase();
  elP1Score.textContent = S.p1Score;
  elP2Score.textContent = S.p2Score;
}

function endRound(winner) {
  if (S.phase !== 'playing') return;
  S.roundWinner = winner;
  S.roundEnd    = performance.now();
  if (winner === 1) S.p1Score++;
  else if (winner === 2) S.p2Score++;
  S.phase = 'round_end';

  elP1Score.textContent = S.p1Score;
  elP2Score.textContent = S.p2Score;

  const msgs = { 0: '⏰ WAKTU HABIS!', 1: '🎉 PLAYER 1 MENANG!', 2: '🎉 PLAYER 2 MENANG!' };
  const cols = { 0: 'var(--text)', 1: 'var(--p1)', 2: 'var(--p2)' };
  document.getElementById('re-round-label').textContent = `Round ${S.round} Selesai`;
  const msgEl = document.getElementById('re-message');
  msgEl.textContent = msgs[winner];
  msgEl.style.color = cols[winner];
  document.getElementById('re-object').textContent = S.target.toUpperCase();
  document.getElementById('re-p1').textContent = S.p1Score;
  document.getElementById('re-p2').textContent = S.p2Score;

  showScreen('roundEnd');

  // Auto-advance
  let t = CFG.countdownSecs;
  const nextEl = document.getElementById('re-next');
  nextEl.textContent = `Ronde berikutnya dalam ${t}...`;
  const tick = setInterval(() => {
    t--;
    if (t > 0) {
      nextEl.textContent = `Ronde berikutnya dalam ${t}...`;
    } else {
      clearInterval(tick);
      if (S.round >= CFG.totalRounds) endGame();
      else beginCountdown();
    }
  }, 1000);
}

function endGame() {
  S.gameWinner = S.p1Score > S.p2Score ? 1 : S.p2Score > S.p1Score ? 2 : 0;
  S.phase = 'game_over';

  const msgs = { 0: '🤝 SERI! SAMA KUAT!', 1: '🏆 PLAYER 1 JUARA!', 2: '🏆 PLAYER 2 JUARA!' };
  const cols = { 0: 'var(--text)', 1: 'var(--p1)', 2: 'var(--p2)' };
  const winEl = document.getElementById('go-winner');
  winEl.textContent = msgs[S.gameWinner];
  winEl.style.color = cols[S.gameWinner];
  document.getElementById('go-p1').textContent = S.p1Score;
  document.getElementById('go-p2').textContent = S.p2Score;
  showScreen('gameOver');
}

function resetGame() {
  S.phase      = 'waiting';
  S.p1Score    = 0; S.p2Score  = 0;
  S.round      = 0;
  S.usedObjects = [];
  S.p1Results  = []; S.p2Results = [];
  S.p1FoundAt  = 0; S.p2FoundAt = 0;
  S.apiTurn    = 1; S.lastApiTime = 0;
  showScreen('waiting');
}

// ── API ──────────────────────────────────────────────────
async function captureHalf(player) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  const oc  = new OffscreenCanvas(Math.floor(vw / 2), vh);
  const oct = oc.getContext('2d');
  // After horizontal flip on canvas, left screen = right half of raw video
  const sx  = player === 1 ? Math.floor(vw / 2) : 0;
  oct.drawImage(video, sx, 0, Math.floor(vw / 2), vh, 0, 0, oc.width, vh);
  return oc.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
}

async function sendFrame(player) {
  const blob = await captureHalf(player);
  if (!blob) { player === 1 ? (S.processingP1 = false) : (S.processingP2 = false); return; }

  const fd = new FormData();
  fd.append('file', blob, 'frame.jpg');

  try {
    const res  = await fetch('/detect', { method: 'POST', body: fd });
    const json = await res.json();
    const data = json.data || [];
    if (player === 1) S.p1Results = data;
    else              S.p2Results = data;
  } catch (e) {
    console.warn('API error:', e);
  } finally {
    if (player === 1) S.processingP1 = false;
    else              S.processingP2 = false;
  }
}

function checkTarget(results) {
  for (const item of results) {
    for (const [name, data] of Object.entries(item)) {
      if (name.toLowerCase() === 'person') continue; // skip person detections
      if (name.toLowerCase() === S.target.toLowerCase() &&
          data.conf_score >= CFG.confThreshold) return true;
    }
  }
  return false;
}

// ── Drawing ──────────────────────────────────────────────
function drawBBoxes(results, xOff, sw, sh, vw, vh, color, targetColor) {
  const scaleX = sw / vw;
  const scaleY = sh / vh;

  for (const item of results) {
    for (const [name, data] of Object.entries(item)) {
      if (name.toLowerCase() === 'person') continue; // skip person detections
      const bbox = data.bbox;
      const conf = data.conf_score;
      if (!bbox || bbox.length < 2) continue;

      const isTarget = name.toLowerCase() === S.target.toLowerCase()
                    && conf >= CFG.confThreshold;
      const col  = isTarget ? targetColor : color;
      const lw   = isTarget ? 3 : 1.5;
      const alpha = isTarget ? 1 : 0.55;

      let x1 = bbox[0][0] * scaleX + xOff;
      let y1 = bbox[0][1] * scaleY;
      let x2 = bbox[1][0] * scaleX + xOff;
      let y2 = bbox[1][1] * scaleY;

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth   = lw;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      // Label background
      const label = `${name} ${(conf * 100).toFixed(0)}%`;
      ctx.font = `${isTarget ? 'bold ' : ''}13px Outfit, sans-serif`;
      const tw = ctx.measureText(label).width;
      const ly = Math.max(y1 - 4, 18);
      ctx.fillStyle = col;
      ctx.globalAlpha = isTarget ? 0.9 : 0.6;
      ctx.fillRect(x1 - 1, ly - 15, tw + 8, 18);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#08090f';
      ctx.fillText(label, x1 + 3, ly);
    }
  }
  ctx.globalAlpha = 1;
}

// ── Render Loop ──────────────────────────────────────────
function renderLoop() {
  requestAnimationFrame(renderLoop);

  const now     = performance.now();
  const W       = canvas.width;
  const H       = canvas.height;
  const halfW   = W / 2;

  // ── Draw video frame (non-mirrored / flipped) ──
  if (video.readyState >= 2 && video.videoWidth > 0) {
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
  } else {
    ctx.fillStyle = '#08090f';
    ctx.fillRect(0, 0, W, H);
  }

  // ── Draw divider ──
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(halfW, 0);
  ctx.lineTo(halfW, H);
  ctx.stroke();

  // ── Phase-specific logic ──
  if (S.phase === 'countdown') {
    const elapsed = (now - S.cdStart) / 1000;
    const secs    = Math.ceil(CFG.countdownSecs - elapsed);
    const numEl   = document.getElementById('cd-number');
    numEl.textContent = Math.max(1, secs);
    const pulse   = 1 + 0.08 * Math.sin(elapsed * Math.PI * 6);
    numEl.style.transform = `scale(${pulse})`;
    if (elapsed >= CFG.countdownSecs) beginRound();
  }

  if (S.phase === 'playing' || S.phase === 'round_end') {
    const vw = video.videoWidth || W;
    const vh = video.videoHeight || H;

    // Draw bboxes
    drawBBoxes(S.p1Results, 0,     halfW, H, Math.floor(vw / 2), vh, 'rgba(255,123,53,0.85)', '#00ff88');
    drawBBoxes(S.p2Results, halfW, halfW, H, Math.floor(vw / 2), vh, 'rgba(0,212,255,0.85)',  '#00ff88');
  }

  if (S.phase === 'playing') {
    const elapsed = (now - S.roundStart) / 1000;
    const remaining = Math.max(0, CFG.roundTime - elapsed);

    // Timer UI
    const secs   = Math.ceil(remaining);
    elTimerVal.textContent = secs;
    elTimerVal.style.color = remaining < 10 ? '#ff4040' : 'var(--text)';
    elRingFg.style.stroke  = remaining < 10 ? '#ff4040' : 'var(--target)';
    const dashOffset = RING_CIRC * (1 - remaining / CFG.roundTime);
    elRingFg.style.strokeDashoffset = dashOffset;

    // API alternating calls
    if (now - S.lastApiTime > CFG.apiIntervalMs) {
      if (S.apiTurn === 1 && !S.processingP1) {
        S.processingP1 = true;
        S.lastApiTime  = now;
        S.apiTurn      = 2;
        sendFrame(1);
      } else if (S.apiTurn === 2 && !S.processingP2) {
        S.processingP2 = true;
        S.lastApiTime  = now;
        S.apiTurn      = 1;
        sendFrame(2);
      }
    }

    // Update API indicator dots
    elP1Dot.classList.toggle('active', S.processingP1);
    elP2Dot.classList.toggle('active', S.processingP2);

    // Check for winner
    const p1Found = checkTarget(S.p1Results);
    const p2Found = checkTarget(S.p2Results);
    if (p1Found && S.p1FoundAt === 0) { S.p1FoundAt = now; endRound(1); }
    else if (p2Found && S.p2FoundAt === 0) { S.p2FoundAt = now; endRound(2); }
    else if (remaining <= 0) endRound(0);

    // Flash effects
    const p1Elapsed = S.p1FoundAt ? now - S.p1FoundAt : Infinity;
    const p2Elapsed = S.p2FoundAt ? now - S.p2FoundAt : Infinity;
    elP1Flash.classList.toggle('show', p1Elapsed < CFG.flashDuration);
    elP2Flash.classList.toggle('show', p2Elapsed < CFG.flashDuration);

    // Flash overlay on canvas
    if (p1Elapsed < CFG.flashDuration) {
      const a = 0.18 * (1 - p1Elapsed / CFG.flashDuration);
      ctx.fillStyle = `rgba(0,255,136,${a})`;
      ctx.fillRect(0, 0, halfW, H);
    }
    if (p2Elapsed < CFG.flashDuration) {
      const a = 0.18 * (1 - p2Elapsed / CFG.flashDuration);
      ctx.fillStyle = `rgba(0,255,136,${a})`;
      ctx.fillRect(halfW, 0, halfW, H);
    }
  }
}

// ── Event Listeners ──────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', () => {
  S.p1Score = 0; S.p2Score = 0;
  S.round   = 0; S.usedObjects = [];
  beginCountdown();
});

document.getElementById('btn-replay').addEventListener('click', resetGame);

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && S.phase === 'waiting') {
    e.preventDefault();
    document.getElementById('btn-start').click();
  }
  if (e.code === 'KeyR' && S.phase === 'game_over') resetGame();
});

window.addEventListener('resize', resizeCanvas);

// Ganti kamera buttons — bisa dari waiting screen atau header icon
document.getElementById('btn-change-cam').addEventListener('click', openCameraSelector);
document.getElementById('btn-switch-cam').addEventListener('click', openCameraSelector);

// ── Init ─────────────────────────────────────────────────
(async () => {
  await setupCamera();
  requestAnimationFrame(renderLoop);
})();
