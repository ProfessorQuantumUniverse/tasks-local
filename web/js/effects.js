import state from './state.js';
import { hexToRgb } from './util.js';

/** Purely decorative background and celebration effects. */

let matrixAnimId = null;
let matrixResizeBound = false;

export function startMatrixRain() {
    const canvas = document.getElementById('matrix-canvas');
    if (!canvas || matrixAnimId) return;

    const ctx = canvas.getContext('2d');
    const resize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    resize();
    if (!matrixResizeBound) {
        window.addEventListener('resize', resize);
        matrixResizeBound = true;
    }

    const chars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノ#@!?<>{}[]▓░'.split('');
    const fontSize = 14;
    const drops = Array(Math.ceil(window.innerWidth / fontSize)).fill(1);

    const draw = () => {
        if (!document.body.classList.contains('pref-matrix')) {
            matrixAnimId = null;
            return;
        }
        ctx.fillStyle = 'rgba(0,0,0,0.05)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = `rgba(${hexToRgb(state.settings.accentColor)}, 0.65)`;
        ctx.font = `${fontSize}px monospace`;
        drops.forEach((y, i) => {
            ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * fontSize, y * fontSize);
            if (y * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
            drops[i] += 1;
        });
        matrixAnimId = requestAnimationFrame(draw);
    };
    draw();
}

export function stopMatrixRain() {
    if (matrixAnimId) {
        cancelAnimationFrame(matrixAnimId);
        matrixAnimId = null;
    }
    const canvas = document.getElementById('matrix-canvas');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

export function launchConfetti() {
    // The library is a plain script tag; if it failed to load, skip silently.
    if (typeof window.confetti === 'undefined') return;

    const colors = ['#00ff88', '#00dd77', '#00bb66', '#88ffcc', '#aaffd9', '#ffffff', '#00ff44'];

    window.confetti({
        particleCount: 200,
        spread: 100,
        startVelocity: 65,
        origin: { y: 0.6 },
        colors,
        zIndex: 9999,
    });

    const end = Date.now() + 3500;
    const tick = setInterval(() => {
        if (Date.now() > end) {
            clearInterval(tick);
            return;
        }
        window.confetti({ particleCount: 55, angle: 60, spread: 60, origin: { x: 0, y: 0.65 }, colors, zIndex: 9999 });
        window.confetti({ particleCount: 55, angle: 120, spread: 60, origin: { x: 1, y: 0.65 }, colors, zIndex: 9999 });
    }, 230);
}
