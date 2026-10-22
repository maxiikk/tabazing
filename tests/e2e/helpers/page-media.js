// Served to the e2e test pages as /page-media.js (plain script, page world): makes media in the page, so the
// suite needs no binary fixtures. window.E2E = { wav, record }.
(() => {
  // A WAV (PCM 16-bit mono) of `seconds` of a sine tone, or of silence (`silent`), as a blob: URL.
  function wav(seconds, { frequency = 440, rate = 8000, silent = false } = {}) {
    const sampleCount = Math.round(seconds * rate);
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);
    const writeString = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeString(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true); writeString(8, 'WAVE');
    writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeString(36, 'data'); view.setUint32(40, sampleCount * 2, true);
    for (let i = 0; i < sampleCount; i++) view.setInt16(44 + i * 2, silent ? 0 : Math.round(8000 * Math.sin((2 * Math.PI * frequency * i) / rate)), true);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }
  // A webm recorded from a canvas (a picture) with or without an oscillator's sound, `seconds` long (real
  // time). Resolves to the recording's bytes as base64 (the test serves them over http).
  async function record(seconds, { sound = true } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    const drawingContext = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    let audioContext = null;
    if (sound) {
      audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
    }
    let frame = 0;
    const draw = setInterval(() => { drawingContext.fillStyle = `hsl(${(frame++ * 7) % 360} 80% 50%)`; drawingContext.fillRect(0, 0, 160, 120); }, 33);
    const recorder = new MediaRecorder(stream, { mimeType: sound ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const done = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(250);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    recorder.stop();
    await done;
    clearInterval(draw);
    if (audioContext) audioContext.close();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binaryString = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binaryString += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binaryString);
  }
  window.E2E = { wav, record };
})();
