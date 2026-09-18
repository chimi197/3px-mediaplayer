// Hidden YouTube player. The client sends a "sync" message 4x per second describing what
// should be playing; this page converges on it and reports title/duration/errors back.
//
// Like pmms, it reaches into the YouTube iframe (FiveM's DUI browser allows this) to:
//  - detect ads, so it never seeks/reloads while one is showing (that caused an ad loop),
//  - optionally skip/fast-forward ads,
//  - read the audio for the visualizer in the media player window.
(() => {
    'use strict';

    const params = new URLSearchParams(location.hash.slice(1));
    const resource = params.get('resource') || '3pixeli-mediaplayer';
    const handle = params.get('handle') || '';

    const SYNC_TOLERANCE = 2.5;   // seconds of drift allowed before seeking
    const SEEK_COOLDOWN = 4000;   // ms between corrective seeks
    const LEVEL_BANDS = 24;       // bars in the visualizer
    const LEVEL_INTERVAL = 80;    // ms between level updates

    let player = null;
    let playerReady = false;
    let currentItem = null;       // queue item id currently loaded (same video can be queued twice)
    let desired = null;
    let lastSeek = 0;
    let wasAd = false;
    const reportedInfo = new Set();
    const reportedError = new Set();

    function post(name, data) {
        return fetch(`https://${resource}/${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(Object.assign({ handle }, data)),
        }).catch(() => {});
    }

    /* ---------- access to the YouTube iframe ---------- */

    function innerDoc() {
        try {
            return player.getIframe().contentWindow.document || null;
        } catch (e) {
            return null; // cross-origin access not allowed (outside FiveM)
        }
    }

    function innerVideo() {
        const doc = innerDoc();
        return doc ? doc.querySelector('video.html5-main-video') || doc.querySelector('video') : null;
    }

    function adShowing() {
        const doc = innerDoc();
        return !!(doc && doc.querySelector('.ad-showing, .ad-interrupting'));
    }

    function skipAd() {
        const doc = innerDoc();
        if (!doc) return;
        const button = doc.querySelector(
            '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-overlay-close-button'
        );
        if (button) button.click();
        const video = innerVideo();
        if (video && isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) {
            video.currentTime = video.duration - 0.1;
        }
    }

    /* ---------- playback ---------- */

    function seek(seconds) {
        lastSeek = Date.now();
        player.seekTo(seconds, true);
    }

    function load(videoId, seconds, paused) {
        lastSeek = Date.now();
        const opts = { videoId, startSeconds: Math.floor(seconds) };
        if (paused) player.cueVideoById(opts);
        else player.loadVideoById(opts);
    }

    // Duration/title are only trusted while the real video (not an ad) is playing.
    function maybeReportInfo(state) {
        if (currentItem === null || reportedInfo.has(currentItem)) return;
        if (state !== YT.PlayerState.PLAYING || adShowing()) return;

        let data = {};
        try { data = player.getVideoData() || {}; } catch (e) { /* not available */ }
        if (desired && data.video_id && data.video_id !== desired.videoId) return;

        const isLive = !!data.isLive;
        const duration = player.getDuration();
        if (!isLive && !(duration > 0)) return;

        const video = innerVideo();
        if (!isLive && video && isFinite(video.duration) && Math.abs(video.duration - duration) > 1.5) return;

        reportedInfo.add(currentItem);
        post('duiInfo', {
            itemId: currentItem,
            duration: isLive ? 0 : duration,
            title: data.title || '',
        });
    }

    function apply() {
        if (!playerReady || !desired) return;
        const d = desired;
        const S = YT.PlayerState;

        if (!d.videoId) {
            if (currentItem !== null) {
                player.stopVideo();
                currentItem = null;
            }
            return;
        }

        if (currentItem !== d.itemId) {
            currentItem = d.itemId;
            wasAd = false;
            load(d.videoId, Math.max(0, d.position || 0), d.paused);
            return;
        }

        const ad = adShowing();
        const volume = ad ? 0 : Math.round(Math.max(0, Math.min(1, d.volume || 0)) * 100);
        if (player.getVolume() !== volume) player.setVolume(volume);
        if (player.isMuted()) player.unMute();

        if (ad) {
            // Never seek or reload during an ad: that restarts it.
            wasAd = true;
            if (d.skipAds) skipAd();
            return;
        }
        if (wasAd) {
            wasAd = false;
            lastSeek = 0; // allow an immediate catch-up seek after the ad
        }

        const state = player.getPlayerState();
        maybeReportInfo(state);

        const target = Math.max(0, d.position || 0);
        const canSeek = Date.now() - lastSeek > SEEK_COOLDOWN;

        if (d.paused) {
            if (state === S.PLAYING || state === S.BUFFERING) {
                player.pauseVideo();
            } else if (state === S.PAUSED && canSeek && Math.abs(player.getCurrentTime() - target) > SYNC_TOLERANCE) {
                seek(target); // stays paused
            }
            return;
        }

        // Past the end: the server moves to the next queue item on its own.
        if (d.duration && target >= d.duration - 1) return;

        if (state === S.CUED || state === S.ENDED) {
            if (canSeek) {
                seek(target); // starts playback from a cued/ended state
                player.playVideo();
            }
        } else if (state === S.PAUSED) {
            seek(target);
            player.playVideo();
        } else if (state === S.PLAYING && canSeek) {
            // Only correct drift when the loaded media is really our video.
            const duration = player.getDuration();
            const isOurVideo = !d.duration || Math.abs(duration - d.duration) < 2;
            if (isOurVideo && Math.abs(player.getCurrentTime() - target) > SYNC_TOLERANCE) {
                seek(target);
            }
        }
        // UNSTARTED / BUFFERING: YouTube is still loading, wait.
    }

    /* ---------- audio levels for the visualizer ---------- */

    let audioCtx = null;
    let analyser = null;
    let routedVideo = null;
    let freq = null;
    let audioFailed = false;

    function getAnalyser() {
        if (audioFailed) return null;
        const video = innerVideo();
        if (!video) return null;
        if (routedVideo === video) return analyser;

        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state !== 'running') {
                // Don't route audio through a context that isn't running, or it would go silent.
                audioCtx.resume();
                return null;
            }
            if (!analyser) {
                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.72;
                analyser.connect(audioCtx.destination);
                freq = new Uint8Array(analyser.frequencyBinCount);
            }
            audioCtx.createMediaElementSource(video).connect(analyser);
            routedVideo = video;
            return analyser;
        } catch (e) {
            audioFailed = true;
            return null;
        }
    }

    function computeLevels() {
        analyser.getByteFrequencyData(freq);
        const maxBin = Math.min(freq.length - 1, 180);
        const levels = [];
        for (let i = 0; i < LEVEL_BANDS; i++) {
            const from = Math.floor(Math.pow(maxBin, i / LEVEL_BANDS));
            const to = Math.max(from + 1, Math.floor(Math.pow(maxBin, (i + 1) / LEVEL_BANDS)));
            let sum = 0;
            for (let b = from; b < to; b++) sum += freq[b];
            const avg = sum / (to - from) / 255;
            levels.push(Math.round(Math.min(1, avg * (1 + i / LEVEL_BANDS)) * 100));
        }
        return levels;
    }

    let sendingLevels = false;
    setInterval(() => {
        if (!playerReady || !desired || !desired.levels || sendingLevels) return;
        let levels;
        if (!desired.videoId || desired.paused || adShowing()) {
            levels = new Array(LEVEL_BANDS).fill(0);
        } else {
            const a = getAnalyser();
            if (!a) return;
            levels = computeLevels();
        }
        sendingLevels = true;
        post('duiLevels', { levels }).finally(() => { sendingLevels = false; });
    }, LEVEL_INTERVAL);

    /* ---------- setup ---------- */

    window.onYouTubeIframeAPIReady = () => {
        player = new YT.Player('player', {
            width: '100%',
            height: '100%',
            playerVars: {
                autoplay: 1,
                controls: 0,
                disablekb: 1,
                fs: 0,
                iv_load_policy: 3,
                rel: 0,
                playsinline: 1,
                origin: location.origin,
            },
            events: {
                onReady: () => {
                    playerReady = true;
                    apply();
                },
                onError: (e) => {
                    if (currentItem === null || reportedError.has(currentItem)) return;
                    reportedError.add(currentItem);
                    post('duiError', { itemId: currentItem, code: e.data });
                },
            },
        });
    };

    window.addEventListener('message', (event) => {
        let msg = event.data;
        if (typeof msg === 'string') {
            try { msg = JSON.parse(msg); } catch (e) { return; }
        }
        if (!msg || msg.type !== 'sync') return;
        desired = msg;
        apply();
    });
})();
