// Hidden YouTube player. The client sends a "sync" message every 250 ms describing what
// should be playing; this page converges on it and reports title/duration/errors back.
(() => {
    'use strict';

    const params = new URLSearchParams(location.hash.slice(1));
    const resource = params.get('resource') || 'mediaplayer';
    const handle = params.get('handle') || '';

    const SYNC_TOLERANCE = 2.5; // seconds of drift allowed before seeking
    const SEEK_COOLDOWN = 3000; // ms between corrective seeks

    let player = null;
    let playerReady = false;
    let currentItem = null;     // queue item id currently loaded (same video can be queued twice)
    let desired = null;
    let lastSeek = 0;
    const reportedInfo = new Set();
    const reportedError = new Set();

    function post(name, data) {
        fetch(`https://${resource}/${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(Object.assign({ handle }, data)),
        }).catch(() => {});
    }

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

    function reportInfo() {
        if (currentItem === null || reportedInfo.has(currentItem)) return;
        let data = {};
        try { data = player.getVideoData() || {}; } catch (e) { /* not available */ }
        const isLive = !!data.isLive;
        const duration = player.getDuration();
        if (!isLive && !(duration > 0)) return;
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

        const volume = Math.round(Math.max(0, Math.min(1, d.volume || 0)) * 100);
        if (player.getVolume() !== volume) player.setVolume(volume);
        if (player.isMuted()) player.unMute();

        const target = Math.max(0, d.position || 0);

        if (currentItem !== d.itemId) {
            currentItem = d.itemId;
            load(d.videoId, target, d.paused);
            return;
        }

        const state = player.getPlayerState();

        if (d.paused) {
            if (state === S.PLAYING || state === S.BUFFERING) {
                player.pauseVideo();
            } else if (state === S.PAUSED && Date.now() - lastSeek > SEEK_COOLDOWN
                    && Math.abs(player.getCurrentTime() - target) > SYNC_TOLERANCE) {
                seek(target); // stays paused
            }
            return;
        }

        // Past the end: the server moves to the next queue item on its own.
        if (d.duration && target >= d.duration - 1) return;

        if (state === S.UNSTARTED || state === S.CUED || state === S.ENDED) {
            if (Date.now() - lastSeek > SEEK_COOLDOWN) load(d.videoId, target, false);
        } else if (state === S.PAUSED) {
            seek(target);
            player.playVideo();
        } else if (state === S.PLAYING && Date.now() - lastSeek > SEEK_COOLDOWN
                && Math.abs(player.getCurrentTime() - target) > SYNC_TOLERANCE) {
            seek(target);
        }
    }

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
                onStateChange: (e) => {
                    if (e.data === YT.PlayerState.PLAYING) reportInfo();
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
