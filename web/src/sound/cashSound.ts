/**
 * A short cash register sound, made with the Web Audio API so no audio file is shipped. Browsers
 * only let a page play sound after the user touched it, so the audio starts on the first tap or key.
 */

const STORAGE_KEY = "inti.sound";
let audio: AudioContext | null = null;

/** Whether the user left the sound on. On unless they turned it off; storage may be blocked. */
export function soundOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
}

/** Creates the audio on the first tap or key, the moment browsers allow it. */
export function unlockSoundOnFirstTouch(): void {
  const unlock = () => {
    try {
      audio ??= new AudioContext();
      void audio.resume();
    } catch {
      audio = null;
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/** One bell tone that rings and fades. */
function bell(ctx: AudioContext, frequency: number, at: number, length: number, volume: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** The drawer's "cha": a short burst of filtered noise. */
function drawer(ctx: AudioContext, at: number): void {
  const length = 0.08;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length);
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 3200;
  const gain = ctx.createGain();
  gain.gain.value = 0.25;
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(at);
}

/** "Cha-ching", when the sound is on and the browser already allows audio. */
export function playCash(): void {
  if (!audio || audio.state !== "running" || !soundOn()) return;
  const now = audio.currentTime;
  drawer(audio, now);
  bell(audio, 2637, now + 0.07, 0.5, 0.18);
  bell(audio, 3520, now + 0.13, 0.7, 0.14);
  bell(audio, 5274, now + 0.13, 0.35, 0.05);
}
