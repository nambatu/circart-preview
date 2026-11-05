// CIRCArt Preview — a small banner so a test build is never mistaken for the
// real game. Tap it for "What's new / what to test".
(function () {
    'use strict';
    fetch('preview.json', { cache: 'no-store' }).then(r => r.json()).catch(() => ({})).then(info => {
        const a = document.createElement('a');
        a.href = 'changes.html';
        a.textContent = 'PREVIEW · ' + (info.label || '') + ' · What\'s new ›';
        a.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:3000;' +
            'background:#c9a227;color:#1c1a17;font:600 11px Inter,system-ui,sans-serif;letter-spacing:.5px;' +
            'padding:3px 10px;border-radius:0 0 8px 8px;text-decoration:none;white-space:nowrap;' +
            'margin-top:env(safe-area-inset-top,0px)';
        document.body.appendChild(a);
    });
})();
