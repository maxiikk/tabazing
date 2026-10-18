// Served to the e2e test pages as /page-media.js (plain script, page world): makes media in the page, so the
// suite needs no binary fixtures. window.E2E = { wav, record }.
(() => {
  // A WAV (PCM 16-bit mono) of `seconds` of a sine tone, or of silence (`silent`), as a blob: URL.
  function wav(seconds, { freq = 440, rate = 8000, silent = false } = {}) {
    const n = Math.round(seconds * rate);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, silent ? 0 : Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / rate)), true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  // A webm recorded from a canvas (a picture) with or without an oscillator's sound, `seconds` long (real
  // time). Resolves to the recording's bytes as base64 (the test serves them over http).
  async function record(seconds, { sound = true } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    const g = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    let ctx = null;
    if (sound) {
      ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest); osc.start();
      stream.addTrack(dest.stream.getAudioTracks()[0]);
    }
    let frame = 0;
    const draw = setInterval(() => { g.fillStyle = `hsl(${(frame++ * 7) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 120); }, 33);
    const rec = new MediaRecorder(stream, { mimeType: sound ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(250);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    rec.stop();
    await done;
    clearInterval(draw);
    if (ctx) ctx.close();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  window.E2E = { wav, record };
})();
