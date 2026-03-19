/* =====================================================
   PDF Compressor — main.js
   Strategy: pdf.js renders each page → JPEG canvas
             → pdf-lib embeds → new smaller PDF
   ===================================================== */

// ── PDF.js worker ──────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Quality presets ────────────────────────────────────
const QUALITY_PRESETS = {
    small:    { scale: 1.2, jpegQuality: 0.50 },
    balanced: { scale: 1.5, jpegQuality: 0.72 },
    quality:  { scale: 2.0, jpegQuality: 0.88 },
};

// ── State ──────────────────────────────────────────────
let files = [];           // { id, file }
let currentQuality = 'balanced';
let isCompressing = false;
let globalDragCounter = 0;
let isFileDragging = false;

// ── DOM refs ───────────────────────────────────────────
const fileInput      = document.getElementById('fileInput');
const dropZone       = document.getElementById('dropZone');
const compressSection = document.getElementById('compressSection');
const fileCards      = document.getElementById('fileCards');
const actionSummary  = document.getElementById('actionSummary');
const compressBtn    = document.getElementById('compressBtn');
const clearBtn       = document.getElementById('clearBtn');
const progressTrack  = document.getElementById('progressTrack');
const progressFill   = document.getElementById('progressFill');
const globalDropOverlay = document.getElementById('globalDropOverlay');

// ── Service Worker ─────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/pdf-compressor/sw.js')
            .then(reg => {
                if (reg.active) showSwBadge();
                reg.addEventListener('updatefound', () => {
                    reg.installing?.addEventListener('statechange', e => {
                        if (e.target.state === 'activated') showSwBadge();
                    });
                });
            }).catch(() => {});
    });
}
function showSwBadge() {
    const li = document.getElementById('swBadgeLi');
    if (li) li.style.display = '';
}

// ── Quality buttons ────────────────────────────────────
document.querySelectorAll('.quality-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentQuality = btn.dataset.quality;
    });
});

// ── File input ─────────────────────────────────────────
fileInput.addEventListener('change', () => {
    handleFiles([...fileInput.files]);
    fileInput.value = '';
});

// ── Drop zone ──────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', e => {
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
    hideDropOverlay();
    const dropped = [...e.dataTransfer.files].filter(f => f.type === 'application/pdf');
    if (dropped.length) handleFiles(dropped);
});

// ── Global drag & drop ─────────────────────────────────
document.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    isFileDragging = true;
    globalDragCounter++;
    if (globalDragCounter === 1) showDropOverlay();
});
document.addEventListener('dragleave', e => {
    if (!isFileDragging) return;
    globalDragCounter--;
    if (globalDragCounter <= 0) { globalDragCounter = 0; hideDropOverlay(); }
});
document.addEventListener('dragover', e => {
    if (isFileDragging) e.preventDefault();
});
document.addEventListener('drop', e => {
    if (!isFileDragging) return;
    e.preventDefault();
    if (!dropZone.contains(e.target)) {
        const dropped = [...e.dataTransfer.files].filter(f => f.type === 'application/pdf');
        if (dropped.length) handleFiles(dropped);
    }
    globalDragCounter = 0;
    isFileDragging = false;
    hideDropOverlay();
});
document.addEventListener('dragend', () => {
    globalDragCounter = 0;
    isFileDragging = false;
    hideDropOverlay();
});

function showDropOverlay() {
    globalDropOverlay.classList.add('active');
}
function hideDropOverlay() {
    globalDropOverlay.classList.remove('active');
    isFileDragging = false;
    globalDragCounter = 0;
}

// ── Clear button ───────────────────────────────────────
clearBtn.addEventListener('click', () => {
    files = [];
    fileCards.innerHTML = '';
    compressSection.style.display = 'none';
    setProgress(0);
});

// ── Compress button ────────────────────────────────────
compressBtn.addEventListener('click', compressAll);

// ── Handle files ───────────────────────────────────────
function handleFiles(newFiles) {
    const pdfs = newFiles.filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (!pdfs.length) return;

    pdfs.forEach(f => {
        const id = Date.now() + Math.random();
        files.push({ id, file: f });
        renderCard({ id, file: f });
    });

    compressSection.style.display = '';
    updateSummary();
    compressBtn.disabled = false;
}

// ── Render file card ───────────────────────────────────
function renderCard({ id, file }) {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.id = `card-${id}`;
    card.innerHTML = `
        <div class="file-card-icon"><i class="bi bi-file-earmark-pdf-fill"></i></div>
        <div class="file-card-info">
            <div class="file-card-name" title="${escHtml(file.name)}">${escHtml(file.name)}</div>
            <div class="file-card-size" id="size-${id}">${formatSize(file.size)}</div>
        </div>
        <div class="file-card-status" id="status-${id}">
            <i class="bi bi-clock"></i> Waiting
        </div>
        <button class="btn-remove-file" title="Remove" onclick="removeFile(${id})">
            <i class="bi bi-x-lg"></i>
        </button>
    `;
    fileCards.appendChild(card);
}

// ── Remove a file ──────────────────────────────────────
window.removeFile = function(id) {
    files = files.filter(f => f.id !== id);
    document.getElementById(`card-${id}`)?.remove();
    if (!files.length) {
        compressSection.style.display = 'none';
        setProgress(0);
    } else {
        updateSummary();
    }
};

// ── Update action summary ──────────────────────────────
function updateSummary() {
    actionSummary.textContent = `${files.length} file${files.length !== 1 ? 's' : ''} ready`;
    compressBtn.disabled = files.length === 0 || isCompressing;
}

// ── Progress helpers ───────────────────────────────────
function setProgress(pct) {
    if (pct <= 0) {
        progressTrack.style.display = 'none';
        progressFill.style.width = '0%';
        return;
    }
    progressTrack.style.display = 'block';
    progressFill.style.width = Math.min(pct, 100) + '%';
    if (pct >= 100) setTimeout(() => setProgress(0), 900);
}

function setCardStatus(id, html, className = '') {
    const el = document.getElementById(`status-${id}`);
    if (!el) return;
    el.className = `file-card-status ${className}`;
    el.innerHTML = html;
}

function setCardSize(id, original, compressed) {
    const el = document.getElementById(`size-${id}`);
    if (!el) return;
    const pct = Math.round((1 - compressed / original) * 100);
    el.innerHTML = `${formatSize(original)} → <span class="size-after">${formatSize(compressed)}</span> <span class="size-pct">(-${pct}%)</span>`;
}

// ── Compress all files ─────────────────────────────────
async function compressAll() {
    if (isCompressing || !files.length) return;
    isCompressing = true;
    compressBtn.disabled = true;
    clearBtn.disabled = true;
    compressBtn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Compressing…';

    const preset = QUALITY_PRESETS[currentQuality];
    const total = files.length;

    for (let i = 0; i < total; i++) {
        const { id, file } = files[i];
        const basePct = Math.round((i / total) * 90);
        setProgress(basePct + 5);
        setCardStatus(id, '<i class="bi bi-hourglass-split"></i> Compressing…');

        try {
            const compressed = await compressFile(file, preset, pct => {
                setProgress(basePct + Math.round(pct * (90 / total)));
            });

            // Download
            const a = document.createElement('a');
            const baseName = file.name.replace(/\.pdf$/i, '');
            a.download = `${baseName}_compressed.pdf`;
            const blob = new Blob([compressed], { type: 'application/pdf' });
            a.href = URL.createObjectURL(blob);
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);

            setCardStatus(id, '<i class="bi bi-check-circle-fill"></i> Done', 'done');
            setCardSize(id, file.size, compressed.byteLength);

            if (i < total - 1) await sleep(500);
        } catch (err) {
            console.error(err);
            setCardStatus(id, `<i class="bi bi-exclamation-triangle-fill"></i> Error`, 'error');
        }
    }

    setProgress(100);
    isCompressing = false;
    compressBtn.disabled = false;
    clearBtn.disabled = false;
    compressBtn.innerHTML = '<i class="bi bi-file-zip me-2"></i>Compress &amp; Download';
    actionSummary.textContent = `${total} file${total !== 1 ? 's' : ''} compressed`;
}

// ── Core compression ───────────────────────────────────
async function compressFile(file, preset, onProgress) {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdfDoc.numPages;

    const outPdf = await PDFLib.PDFDocument.create();

    for (let p = 1; p <= numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const viewport = page.getViewport({ scale: preset.scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;

        const jpegDataUrl = canvas.toDataURL('image/jpeg', preset.jpegQuality);
        const jpegBytes = dataUrlToBytes(jpegDataUrl);

        const jpegImage = await outPdf.embedJpg(jpegBytes);
        // Use natural 72-dpi dimensions for the output page
        const nativeWidth  = page.getViewport({ scale: 1 }).width;
        const nativeHeight = page.getViewport({ scale: 1 }).height;
        const outPage = outPdf.addPage([nativeWidth, nativeHeight]);
        outPage.drawImage(jpegImage, {
            x: 0, y: 0,
            width: nativeWidth,
            height: nativeHeight,
        });

        page.cleanup();
        if (onProgress) onProgress(p / numPages);
    }

    return await outPdf.save();
}

// ── Utilities ──────────────────────────────────────────
function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
