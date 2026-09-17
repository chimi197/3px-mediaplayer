// Hidden media player. The client sends a "sync" message every 250 ms describing what should be
// playing; this page converges on it and reports duration/errors back.
//
// Two ways to play, chosen per item by the server:
//   stream - the resolved media URL in a <video> element. No ads are served for it at all.
//   embed  - the YouTube player, used when a media URL could not be resolved. YouTube puts ads
//            in front of those, so everything here treats an ad as "not the video yet".
(() => {
    'use strict';

    const params = new URLSearchParams(location.hash.slice(1));
    const resource = params.get('resource') || 'mediaplayer';
    const handle = params.get('handle') || '';

    const SYNC_TOLERANCE = 2.5; // seconds of drift allowed before seeking
    const SEEK_COOLDOWN = 3000; // ms between corrective seeks

    const media = document.getElementById('media');
    const track = document.getElementById('track');
    const cover = document.getElementById('cover');

    let desired = null;
    const reportedInfo = new Set();
    const streamErrors = new Set();
    const embedErrors = new Set();

    function post(name, data) {
        fetch(`https://${resource}/${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(Object.assign({ handle }, data)),
        }).catch(() => {});
    }

    function clamp01(value) {
        return Math.max(0, Math.min(1, value || 0));
    }

    function reportInfo(itemId, duration, title) {
        if (reportedInfo.has(itemId) || !(duration > 0) || !isFinite(duration)) return;
        reportedInfo.add(itemId);
        post('duiInfo', { itemId, duration, title: title || '' });
    }

    /////////////////////////////////////////////////////////////////////////
    // Direct stream
    /////////////////////////////////////////////////////////////////////////

    // Most videos only exist as a separate video file and audio file, so <audio> carries the sound
    // whenever the server sends one and <video> is muted and slaved to it.
    const TRACK_TOLERANCE = 0.25; // seconds the picture may run ahead of or behind the sound

    let streamItem = null;
    let streamStart = 0;
    let streamSeek = 0;
    let split = false;

    function clearElement(el) {
        if (el.getAttribute('src')) {
            el.pause();
            el.removeAttribute('src');
            el.load();
        }
    }

    function stopStream() {
        streamItem = null;
        split = false;
        clearElement(media);
        clearElement(track);
        media.hidden = true;
    }

    function startPlayback(el) {
        el.play().catch(() => {
            // Some CEF builds refuse to start audible playback without a gesture.
            el.muted = true;
            el.play().catch(() => {});
        });
    }

    media.addEventListener('loadedmetadata', () => {
        if (streamItem === null) return;
        media.currentTime = streamStart;
        streamSeek = Date.now();
        if (!split) reportInfo(streamItem, media.duration);
    });

    track.addEventListener('loadedmetadata', () => {
        if (streamItem === null) return;
        track.currentTime = streamStart;
        streamSeek = Date.now();
        reportInfo(streamItem, track.duration);
    });

    media.addEventListener('playing', () => {
        if (!split) media.muted = false;
    });

    track.addEventListener('playing', () => {
        track.muted = false;
    });

    function streamFailed() {
        if (streamItem === null || streamErrors.has(streamItem)) return;
        streamErrors.add(streamItem);
        post('duiStreamError', { itemId: streamItem });
    }

    media.addEventListener('error', streamFailed);
    track.addEventListener('error', streamFailed);

    function applyStream(d) {
        media.hidden = false;

        if (streamItem !== d.itemId) {
            streamItem = d.itemId;
            streamStart = Math.max(0, d.position || 0);
            streamSeek = Date.now();
            split = !!d.audioUrl;
            media.muted = split;
            media.src = d.streamUrl;
            media.load();
            if (split) {
                track.src = d.audioUrl;
                track.load();
            } else {
                clearElement(track);
            }
        }

        const clock = split ? track : media;
        const volume = clamp01(d.volume);
        clock.volume = volume;
        if (split) media.volume = 0;

        if (d.paused) {
            if (!media.paused) media.pause();
            if (split && !track.paused) track.pause();
        } else {
            if (media.paused && media.readyState > 0) startPlayback(media);
            if (split && track.paused && track.readyState > 0) startPlayback(track);
        }

        if (clock.readyState === 0) return;

        const target = Math.max(0, d.position || 0);
        if (Date.now() - streamSeek > SEEK_COOLDOWN
                && Math.abs(clock.currentTime - target) > SYNC_TOLERANCE) {
            streamSeek = Date.now();
            clock.currentTime = target;
            if (split) media.currentTime = target;
            return;
        }

        // Nudge the picture back onto the sound. The two decode independently, so they drift.
        if (split && media.readyState > 0
                && Math.abs(media.currentTime - track.currentTime) > TRACK_TOLERANCE) {
            media.currentTime = track.currentTime;
        }
    }

    /////////////////////////////////////////////////////////////////////////
    // YouTube embed (fallback)
    /////////////////////////////////////////////////////////////////////////

    let player = null;
    let apiReady = false;
    let playerReady = false;
    let embedItem = null;
    let lastSeek = 0;

    function createPlayer() {
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
                    if (e.data === YT.PlayerState.PLAYING) embedReportInfo();
                },
                onError: (e) => {
                    if (embedItem === null || embedErrors.has(embedItem)) return;
                    embedErrors.add(embedItem);
                    post('duiError', { itemId: embedItem, code: e.data });
                },
            },
        });
    }

    // There is no API for "an ad is playing", but while one is, the player reports the ad's own
    // length and video id instead of the video's. Both are worth catching: acting on ad numbers
    // is what used to make the server cut the video short and run through the whole queue.
    function adShowing() {
        if (!desired || !desired.videoId) return false;
        try {
            const data = player.getVideoData() || {};
            if (data.video_id && data.video_id !== desired.videoId) return true;
            const duration = player.getDuration();
            if (desired.duration && duration > 0
                    && Math.abs(duration - desired.duration) > 2) return true;
        } catch (e) { /* player not far enough along to ask */ }
        return false;
    }

    function embedReportInfo() {
        if (embedItem === null || adShowing()) return;
        let data = {};
        try { data = player.getVideoData() || {}; } catch (e) { /* not available */ }
        if (data.isLive) return;
        reportInfo(embedItem, player.getDuration(), data.title);
    }

    function stopEmbed() {
        if (playerReady && embedItem !== null) player.stopVideo();
        embedItem = null;
    }

    function applyEmbed(d) {
        cover.hidden = false; // lifted below, once the video itself is what is on screen
        if (!apiReady) return;
        if (!player) {
            createPlayer();
            return;
        }
        if (!playerReady) return;

        const S = YT.PlayerState;
        const volume = Math.round(clamp01(d.volume) * 100);
        const target = Math.max(0, d.position || 0);

        if (embedItem !== d.itemId) {
            embedItem = d.itemId;
            lastSeek = Date.now();
            if (d.paused) player.cueVideoById({ videoId: d.videoId, startSeconds: Math.floor(target) });
            else player.loadVideoById({ videoId: d.videoId, startSeconds: Math.floor(target) });
            return;
        }

        // Sit the ad out silently behind the cover. Seeking during one only restarts it, and the
        // server keeps counting, so the drift correction below catches up once the video starts.
        if (adShowing()) {
            if (player.getVolume() !== 0) player.setVolume(0);
            return;
        }
        cover.hidden = true;

        if (player.getVolume() !== volume) player.setVolume(volume);
        if (player.isMuted()) player.unMute();

        const state = player.getPlayerState();

        if (d.paused) {
            if (state === S.PLAYING || state === S.BUFFERING) {
                player.pauseVideo();
            } else if (state === S.PAUSED && Date.now() - lastSeek > SEEK_COOLDOWN
                    && Math.abs(player.getCurrentTime() - target) > SYNC_TOLERANCE) {
                lastSeek = Date.now();
                player.seekTo(target, true); // stays paused
            }
            return;
        }

        // Past the end: the server moves to the next queue item on its own.
        if (d.duration && target >= d.duration - 1) return;

        if (state === S.UNSTARTED || state === S.CUED || state === S.ENDED) {
            if (Date.now() - lastSeek > SEEK_COOLDOWN) {
                lastSeek = Date.now();
                player.loadVideoById({ videoId: d.videoId, startSeconds: Math.floor(target) });
            }
        } else if (state === S.PAUSED) {
            lastSeek = Date.now();
            player.seekTo(target, true);
            player.playVideo();
        } else if (state === S.PLAYING && Date.now() - lastSeek > SEEK_COOLDOWN
                && Math.abs(player.getCurrentTime() - target) > SYNC_TOLERANCE) {
            lastSeek = Date.now();
            player.seekTo(target, true);
        }
    }

    /////////////////////////////////////////////////////////////////////////

    function apply() {
        const d = desired;
        // No mode yet means the server is still working out how to play this item.
        if (!d || !d.videoId || !d.mode) {
            cover.hidden = false;
            stopStream();
            stopEmbed();
            return;
        }

        if (d.mode === 'stream' && d.streamUrl) {
            stopEmbed();
            cover.hidden = true;
            applyStream(d);
        } else {
            stopStream();
            applyEmbed(d);
        }
    }

    window.onYouTubeIframeAPIReady = () => {
        apiReady = true;
        apply();
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
