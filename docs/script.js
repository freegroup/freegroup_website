(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------------------------------------------------------------
    // Greeting
    // ---------------------------------------------------------------
    const hour = new Date().getHours();
    const greeting =
        hour < 5  ? '// still up, stranger? same.' :
        hour < 12 ? '// good morning, stranger.' :
        hour < 18 ? '// good afternoon, stranger.' :
        hour < 23 ? '// good evening, stranger.' :
                    '// still up, stranger? same.';
    document.getElementById('greeting').textContent = greeting;

    // ---------------------------------------------------------------
    // Reveal on scroll
    // ---------------------------------------------------------------
    const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
            if (e.isIntersecting) {
                e.target.classList.add('in');
                io.unobserve(e.target);
            }
        });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

    // ---------------------------------------------------------------
    // The CNC machine in the hero.
    // Renders the text into a mask, turns it into a zig-zag raster
    // toolpath and "mills" it into a wooden plate — with G-code.
    // ---------------------------------------------------------------
    const canvas = document.getElementById('bed');
    const ctx = canvas.getContext('2d');
    const plate = document.createElement('canvas');
    const pctx = plate.getContext('2d');

    const gcodeEl = document.getElementById('gcode');
    const coordsEl = document.getElementById('coords');
    const jobNameEl = document.getElementById('job-name');
    const spindle = document.getElementById('spindle');
    const spindleLabel = document.getElementById('spindle-label');
    const form = document.getElementById('job-form');
    const input = document.getElementById('job-text');

    const MM_PER_PX = 0.1;
    const DURATION = 4200;
    const RAPID_WEIGHT = 0.3; // rapids are "faster" than cuts
    const FONT = '"Bricolage Grotesque", system-ui, sans-serif';

    let W = 0, H = 0, dpr = 1;
    let P = { x: 0, y: 0, w: 0, h: 0 };
    let home = { x: 0, y: 0 };
    let colors = {};
    let job = null;
    let raf = 0;
    let text = 'hello';

    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    function readColors() {
        colors = {
            stock: css('--stock'), grain: css('--grain'), cut: css('--cut'), cutHi: css('--cut-hi'),
            tool: css('--tool'), chip: css('--chip'), gantry: css('--gantry'),
            accent: css('--accent'), edge: css('--line-strong'),
        };
    }

    function resize() {
        const r = canvas.getBoundingClientRect();
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = r.width;
        H = r.height;
        canvas.width = plate.width = Math.round(W * dpr);
        canvas.height = plate.height = Math.round(H * dpr);
        const m = Math.max(14, Math.min(W, H) * 0.08);
        P = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
        home = { x: m * 0.5, y: m * 0.5 };
    }

    function rng(seed) {
        return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    }

    function drawStock() {
        pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        pctx.clearRect(0, 0, W, H);

        pctx.save();
        pctx.shadowColor = 'rgba(0,0,0,0.18)';
        pctx.shadowBlur = 12;
        pctx.shadowOffsetY = 4;
        pctx.fillStyle = colors.stock;
        pctx.beginPath();
        pctx.roundRect(P.x, P.y, P.w, P.h, 8);
        pctx.fill();
        pctx.restore();

        // wood grain
        pctx.save();
        pctx.clip();
        const rand = rng(7);
        pctx.strokeStyle = colors.grain;
        for (let i = 0; i < 70; i++) {
            const y = P.y + rand() * P.h;
            const amp = 1 + rand() * 3;
            const freq = 0.004 + rand() * 0.01;
            pctx.lineWidth = 0.6 + rand() * 1.8;
            pctx.beginPath();
            for (let x = P.x; x <= P.x + P.w + 20; x += 20) {
                pctx.lineTo(x, y + Math.sin(x * freq + i) * amp);
            }
            pctx.stroke();
        }
        pctx.restore();

        pctx.strokeStyle = colors.edge;
        pctx.lineWidth = 1;
        pctx.beginPath();
        pctx.roundRect(P.x + 0.5, P.y + 0.5, P.w - 1, P.h - 1, 8);
        pctx.stroke();
    }

    function plan(str) {
        const mw = Math.ceil(W), mh = Math.ceil(H);
        const mask = document.createElement('canvas');
        mask.width = mw;
        mask.height = mh;
        const mc = mask.getContext('2d', { willReadFrequently: true });

        let size = P.h * 0.78;
        mc.font = `800 ${size}px ${FONT}`;
        const tw = mc.measureText(str).width;
        if (tw > P.w * 0.86) {
            size *= (P.w * 0.86) / tw;
            mc.font = `800 ${size}px ${FONT}`;
        }
        mc.textAlign = 'center';
        mc.textBaseline = 'middle';
        mc.fillText(str, P.x + P.w / 2, P.y + P.h / 2 + size * 0.03);
        const data = mc.getImageData(0, 0, mw, mh).data;

        const step = Math.max(2.4, size / 32);
        const moves = [];
        let cx = home.x, cy = home.y, row = 0;

        for (let y = P.y + step / 2; y < P.y + P.h; y += step, row++) {
            const yi = Math.round(y);
            const runs = [];
            let start = -1;
            for (let x = 0; x < mw; x++) {
                const on = data[(yi * mw + x) * 4 + 3] > 110;
                if (on && start < 0) start = x;
                if (!on && start >= 0) { runs.push([start, x - 1]); start = -1; }
            }
            if (start >= 0) runs.push([start, mw - 1]);
            if (!runs.length) continue;

            const ordered = row % 2 ? runs.reverse().map(([a, b]) => [b, a]) : runs;
            for (const [a, b] of ordered) {
                moves.push({ x0: cx, y0: cy, x1: a, y1: y, cut: false });
                moves.push({ x0: a, y0: y, x1: b, y1: y, cut: true });
                cx = b;
                cy = y;
            }
        }
        moves.push({ x0: cx, y0: cy, x1: home.x, y1: home.y, cut: false });
        moves.forEach((m) => { m.len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0); });
        return { moves, step };
    }

    // --- G-code ---------------------------------------------------

    const mmX = (x) => ((x - P.x) * MM_PER_PX).toFixed(2);
    const mmY = (y) => ((P.y + P.h - y) * MM_PER_PX).toFixed(2);

    function log(line) {
        job.log.push(line);
        if (job.log.length > 16) job.log.shift();
        job.logDirty = true;
    }

    function logMove(mv) {
        if (mv.cut && job.z > 0) { log('G1 Z-1.50 F300'); job.z = -1.5; }
        if (!mv.cut && job.z < 0) { log('G0 Z5.00'); job.z = 5; }
        log(mv.cut
            ? `G1 X${mmX(mv.x1)} Y${mmY(mv.y1)} F1200`
            : `G0 X${mmX(mv.x1)} Y${mmY(mv.y1)}`);
    }

    function flushLog() {
        if (!job.logDirty) return;
        job.logDirty = false;
        gcodeEl.replaceChildren(...job.log.map((l, i) => {
            const d = document.createElement('span');
            d.textContent = l;
            if (i === job.log.length - 1) d.className = 'cur';
            return d;
        }));
    }

    function setStatus(state, label) {
        spindle.dataset.state = state;
        spindleLabel.textContent = label;
    }

    // --- job control ------------------------------------------------

    function slug(str) {
        return (str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job') + '.nc';
    }

    function newJob(str) {
        cancelAnimationFrame(raf);
        text = str;
        resize();
        readColors();
        drawStock();
        const name = slug(str);
        jobNameEl.textContent = name;
        job = {
            ...plan(str),
            i: 0, t: 0, z: 5, x: home.x, y: home.y, cutting: false,
            chips: [], log: [], logDirty: true, last: 0,
        };
        ['%', `(${name})`, 'G21 G90 G17', 'M3 S18000', 'G0 Z5.00'].forEach(log);
        if (job.moves.length) logMove(job.moves[0]);
        job.speed = job.moves.reduce((s, m) => s + m.len * (m.cut ? 1 : RAPID_WEIGHT), 0) / DURATION;
    }

    function cutSegment(mv, a, b) {
        if (b <= a && mv.len > 0) return;
        const k0 = mv.len ? a / mv.len : 0, k1 = mv.len ? b / mv.len : 1;
        const x0 = mv.x0 + (mv.x1 - mv.x0) * k0, x1 = mv.x0 + (mv.x1 - mv.x0) * k1;
        const y0 = mv.y0 + (mv.y1 - mv.y0) * k0, y1 = mv.y0 + (mv.y1 - mv.y0) * k1;
        pctx.lineCap = 'round';
        pctx.strokeStyle = colors.cut;
        pctx.lineWidth = job.step + 0.9;
        pctx.beginPath();
        pctx.moveTo(x0, y0);
        pctx.lineTo(x1, y1);
        pctx.stroke();
        pctx.strokeStyle = colors.cutHi;
        pctx.lineWidth = Math.max(0.6, job.step * 0.22);
        pctx.stroke();
    }

    // advance the job by a distance budget (in weighted px)
    function advance(budget) {
        const { moves } = job;
        while (budget > 0 && job.i < moves.length) {
            const mv = moves[job.i];
            const w = mv.cut ? 1 : RAPID_WEIGHT;
            const take = Math.min(budget, (mv.len - job.t) * w);
            const t0 = job.t;
            job.t += take / w;
            budget -= take;
            if (mv.cut) cutSegment(mv, t0, job.t);
            if (job.t >= mv.len - 1e-6) {
                job.i++;
                job.t = 0;
                if (job.i < moves.length) logMove(moves[job.i]);
            }
        }
        const mv = moves[job.i];
        if (mv) {
            const k = mv.len ? job.t / mv.len : 0;
            job.x = mv.x0 + (mv.x1 - mv.x0) * k;
            job.y = mv.y0 + (mv.y1 - mv.y0) * k;
            job.cutting = mv.cut;
        } else {
            job.x = home.x;
            job.y = home.y;
            job.cutting = false;
        }
    }

    function finishLog() {
        ['M5', 'M30', '(done. no fingers lost.)'].forEach(log);
    }

    function render(dt) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(plate, 0, 0, W, H);

        // gantry
        ctx.strokeStyle = colors.gantry;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(job.x, 0); ctx.lineTo(job.x, H);
        ctx.moveTo(0, job.y); ctx.lineTo(W, job.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // chips
        if (job.cutting && !reduced) {
            for (let n = 0; n < 2; n++) {
                const a = Math.random() * Math.PI * 2, v = 0.06 + Math.random() * 0.12;
                job.chips.push({ x: job.x, y: job.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, s: 1 + Math.random() * 2 });
            }
        }
        ctx.fillStyle = colors.chip;
        job.chips = job.chips.filter((c) => {
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            c.life -= dt / 450;
            if (c.life <= 0) return false;
            ctx.globalAlpha = c.life;
            ctx.fillRect(c.x, c.y, c.s, c.s);
            return true;
        });
        ctx.globalAlpha = 1;

        // tool — bigger + shadow when lifted
        const r = Math.max(5, job.step * 1.2) * (job.cutting ? 1 : 1.25);
        if (!job.cutting) {
            ctx.fillStyle = 'rgba(0,0,0,0.16)';
            ctx.beginPath();
            ctx.arc(job.x + 5, job.y + 7, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillStyle = colors.tool;
        ctx.beginPath();
        ctx.arc(job.x, job.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(job.x, job.y, r + 3, 0, Math.PI * 2);
        ctx.stroke();

        const z = job.cutting ? -1.5 : 5;
        const f = (v) => v.padStart(7, ' ');
        coordsEl.textContent = `X${f(mmX(job.x))}  Y${f(mmY(job.y))}  Z${f(z.toFixed(2))}`;
        flushLog();
    }

    function tick(now) {
        const dt = job.last ? Math.min(now - job.last, 50) : 16;
        job.last = now;
        advance(dt * job.speed);
        render(dt);
        if (job.i < job.moves.length || job.chips.length) {
            raf = requestAnimationFrame(tick);
        } else {
            finishLog();
            flushLog();
            setStatus('done', 'job done ✓');
        }
    }

    function run(str) {
        newJob(str);
        if (reduced) return finishInstant();
        setStatus('run', `milling “${str}”`);
        raf = requestAnimationFrame(tick);
    }

    function finishInstant() {
        advance(Infinity);
        job.chips = [];
        finishLog();
        render(0);
        setStatus('done', 'job done ✓');
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim() || 'hello';
        input.value = v;
        run(v);
    });

    // first run once the font is ready and the machine is on screen
    let started = false;
    // don't wait forever for the font — worst case we mill in system-ui
    const fontReady = Promise.race([
        document.fonts.load(`800 100px ${FONT}`).catch(() => {}),
        new Promise((r) => setTimeout(r, 1500)),
    ]);
    fontReady.then(() => {
        const mo = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !started) {
                started = true;
                mo.disconnect();
                run(text);
            }
        }, { threshold: 0.3 });
        mo.observe(canvas);
    });

    // redraw finished result on resize / theme change
    let lastW = 0, rt = 0;
    new ResizeObserver(() => {
        const w = canvas.getBoundingClientRect().width;
        if (!started || Math.abs(w - lastW) < 2) { lastW = w; return; }
        lastW = w;
        clearTimeout(rt);
        rt = setTimeout(() => { newJob(text); finishInstant(); }, 150);
    }).observe(canvas);

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (started) { newJob(text); finishInstant(); }
    });

    // ---------------------------------------------------------------
    // Draw2D DHTML tribute: a little diagram drawn the 2006 way —
    // one absolutely positioned <div> per pixel.
    // ---------------------------------------------------------------
    const paint = document.getElementById('divpaint');
    const countEl = document.getElementById('divcount');
    if (paint) {
        const PX = 2;
        const pixels = new Map(); // "x,y" -> color, later ones win

        const put = (x, y, c) => pixels.set(`${Math.round(x)},${Math.round(y)}`, c);
        const line = (x0, y0, x1, y1, c) => {
            const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
            const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
            let err = dx + dy;
            for (;;) {
                put(x0, y0, c);
                if (x0 === x1 && y0 === y1) break;
                const e2 = 2 * err;
                if (e2 >= dy) { err += dy; x0 += sx; }
                if (e2 <= dx) { err += dx; y0 += sy; }
            }
        };
        const figure = (x, y, w, h, icon) => {
            for (let j = 0; j <= h; j++) {
                for (let i = 0; i <= w; i++) {
                    const edge = i === 0 || j === 0 || i === w || j === h;
                    put(x + i, y + j, edge ? '#2e7d32' : icon(i, j) ? '#fff' : '#77dd77');
                }
            }
        };

        // "start" figure with a play triangle, "done" figure with a check mark
        figure(14, 24, 36, 36, (i, j) => i >= 12 && i <= 26 && Math.abs(j - 18) <= (26 - i) * 0.62 && Math.abs(j - 18) <= 9);
        figure(108, 44, 36, 36, (i, j) =>
            (i >= 8 && i <= 15 && Math.abs(j - (12 + i)) <= 1.5) ||
            (i >= 15 && i <= 28 && Math.abs(j - (27 - (i - 15) * 1.1)) <= 1.5));

        // bezier connection between the ports
        const bz = (t, a, b, c, d) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
        for (let t = 0; t <= 1; t += 0.004) {
            put(bz(t, 52, 82, 78, 104), bz(t, 42, 42, 62, 62), '#000080');
        }
        line(99, 58, 104, 62, '#000080');
        line(99, 66, 104, 62, '#000080');

        // ports
        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                put(51 + i, 42 + j, '#e53935');
                put(107 + i, 62 + j, '#1e5bd8');
            }
        }

        const list = [...pixels].map(([k, c]) => { const [x, y] = k.split(','); return [+x, +y, c]; });
        paint.append(...list.map(([x, y, c]) => {
            const d = document.createElement('div');
            d.style.cssText = `left:${x * PX}px;top:${y * PX}px;background:${c}`;
            return d;
        }));
        countEl.textContent = list.length.toLocaleString('en-US');
    }

    // ---------------------------------------------------------------
    console.log(
        '%c freegroup.de %c\nReading the source? Respect.\nIt\'s all hand-written — no build step, no framework.\nhttps://github.com/freegroup',
        'background:#ff5b1f;color:#fff;font-weight:bold;padding:4px 8px;border-radius:4px',
        'color:inherit'
    );
})();
