/* ============================================================
   CIRCArt — install and offline support

   Two jobs:
     1. register the service worker
     2. offer installation, which works very differently per platform

   Android/Chrome fires `beforeinstallprompt` and lets us show a real
   Install button. iOS fires nothing at all — Safari can install a web
   app but only through Share -> Add to Home Screen, and most people
   have no idea that exists. So iOS gets an explanation instead.
   ============================================================ */

(function () {
    'use strict';

    // ---------------------------------------------------- service worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('sw.js').catch(function (e) {
                // Registration fails on plain http:// and in some private
                // modes. The game works fine without it; just no offline.
                console.warn('[pwa] service worker not registered:', e);
            });
        });
    }

    // ------------------------------------------------------------ helpers
    var DISMISS_KEY = 'installHintDismissed';

    function wasDismissed() {
        try {
            return localStorage.getItem(DISMISS_KEY) === '1';
        } catch (e) {
            return false;               // storage blocked: just show it
        }
    }

    function remember() {
        try {
            localStorage.setItem(DISMISS_KEY, '1');
        } catch (e) { /* nothing we can do, and nothing that matters */ }
    }

    // Already installed? Then there is nothing to offer.
    function isStandalone() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
               window.navigator.standalone === true;
    }

    function isIos() {
        return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
               // iPadOS 13+ reports itself as a Mac; the touch points give it away.
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    // On iOS only Safari can install — Chrome and Firefox there are
    // WebKit wrappers without the Share > Add to Home Screen entry.
    function isIosSafari() {
        if (!isIos()) return false;
        var ua = navigator.userAgent;
        return !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
    }

    var hint    = document.getElementById('install-hint');
    var text    = document.getElementById('install-hint-text');
    var accept  = document.getElementById('install-accept');
    var dismiss = document.getElementById('install-dismiss');

    if (!hint || !text || !accept || !dismiss) return;

    function show(message, withButton) {
        text.innerHTML = message;
        accept.classList.toggle('hidden', !withButton);
        hint.classList.remove('hidden');
    }

    function hide() {
        hint.classList.add('hidden');
    }

    dismiss.addEventListener('click', function () {
        hide();
        remember();
    });

    if (isStandalone() || wasDismissed()) return;

    // ------------------------------------------------- Android and desktop
    var deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();             // suppress the default mini-infobar
        deferredPrompt = e;
        show('Add <strong>CIRCArt</strong> to your home screen to play it like an app, even offline.', true);
    });

    accept.addEventListener('click', function () {
        if (!deferredPrompt) return;
        var prompt = deferredPrompt;
        deferredPrompt = null;
        hide();
        prompt.prompt();
        // The outcome is worth knowing but not worth acting on.
        if (prompt.userChoice && prompt.userChoice.then) {
            prompt.userChoice.then(function (choice) {
                if (choice && choice.outcome === 'accepted') remember();
            });
        }
    });

    window.addEventListener('appinstalled', function () {
        hide();
        remember();
    });

    // ------------------------------------------------------------- iOS
    // No event to wait for, so show the instructions after a short delay —
    // long enough not to interrupt the first look at the start screen.
    if (isIosSafari()) {
        setTimeout(function () {
            if (isStandalone() || wasDismissed()) return;
            show('Add <strong>CIRCArt</strong> to your home screen: tap the Share button, then <strong>Add to Home Screen</strong>.', false);
        }, 4000);
    }
})();
