/**
 * The game's sound.
 *
 * Every cue has a synthesised recipe built from oscillators and noise, so the
 * game ships with audio and zero asset bytes. Each cue ALSO has a sample slot:
 * list a file in `public/sounds/index.json` and it silently replaces the synth
 * for that cue, with no change to any calling code. See that folder's README.
 *
 * Browsers refuse to start an AudioContext until the user has interacted with
 * the page, so nothing is created until `unlock()` is called from a real
 * gesture. Every `play()` before that is a no-op rather than an error.
 */

export type SoundName =
  | "swing"
  | "hit"
  | "jump"
  | "land"
  | "death"
  | "roundStart"
  | "roundEnd"
  | "matchOver";

export interface PlayOptions {
  /** 0..1, multiplied into the cue's own level. */
  gain?: number;
  /** Playback rate / pitch multiplier. Used to make big hits sound heavier. */
  rate?: number;
}

const MUTE_KEY = "stickstakes:muted";
const SAMPLE_MANIFEST = "/sounds/index.json";

/** Master level. Deliberately conservative: this gets played in public. */
const MASTER_GAIN = 0.32;

export function createAudio() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = readMuted();

  /** Cues that have a decoded sample; anything absent falls back to synth. */
  const samples = new Map<SoundName, AudioBuffer>();

  function readMuted(): boolean {
    try {
      return localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      return false;
    }
  }

  /** One second of white noise, reused by every percussive cue. */
  function makeNoise(context: AudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * Load whatever samples the project has been given. Absent or empty is the
   * normal case — the manifest ships as `{}` so this is one cheap request that
   * never 404s, and the synth recipes stay in charge.
   */
  async function loadSamples(context: AudioContext): Promise<void> {
    try {
      const response = await fetch(SAMPLE_MANIFEST);
      if (!response.ok) return;
      const manifest = (await response.json()) as Partial<Record<SoundName, string>>;
      await Promise.all(
        Object.entries(manifest).map(async ([name, file]) => {
          if (!file) return;
          const audio = await fetch(`/sounds/${file}`);
          if (!audio.ok) return;
          samples.set(name as SoundName, await context.decodeAudioData(await audio.arrayBuffer()));
        }),
      );
    } catch {
      // A broken manifest must never cost you the game's audio.
    }
  }

  /** Call from a real user gesture. Safe to call repeatedly. */
  function unlock(): void {
    if (ctx) {
      if (ctx.state === "suspended") void ctx.resume();
      return;
    }
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(ctx.destination);
      noise = makeNoise(ctx);
      void loadSamples(ctx);
    } catch {
      ctx = null; // No WebAudio: the game is still perfectly playable.
    }
  }

  function envelope(attack: number, decay: number, peak: number): GainNode {
    const now = ctx!.currentTime;
    const gain = ctx!.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    return gain;
  }

  function tone(
    type: OscillatorType,
    from: number,
    to: number,
    duration: number,
    peak: number,
    delay = 0,
  ): void {
    const start = ctx!.currentTime + delay;
    const osc = ctx!.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);

    const gain = ctx!.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain).connect(master!);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function burst(duration: number, peak: number, cutoff: number, sweepTo?: number): void {
    const start = ctx!.currentTime;
    const source = ctx!.createBufferSource();
    source.buffer = noise;

    const filter = ctx!.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(cutoff, start);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);
    filter.Q.value = 1.1;

    const gain = envelope(0.004, duration, peak);
    source.connect(filter).connect(gain).connect(master!);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  /** The synth recipes. `rate` shifts pitch so a heavier hit sounds heavier. */
  function synth(name: SoundName, gain: number, rate: number): void {
    switch (name) {
      case "swing":
        burst(0.09, 0.16 * gain, 900 * rate, 2200 * rate);
        break;
      case "hit":
        // A noise crack over a low thump: the crack locates it, the thump sells it.
        burst(0.08, 0.5 * gain, 1500 * rate, 400 * rate);
        tone("sine", 190 * rate, 60 * rate, 0.16, 0.55 * gain);
        break;
      case "jump":
        tone("square", 240 * rate, 470 * rate, 0.09, 0.11 * gain);
        break;
      case "land":
        burst(0.05, 0.1 * gain, 320 * rate);
        break;
      case "death":
        tone("sawtooth", 320 * rate, 45 * rate, 0.42, 0.3 * gain);
        burst(0.3, 0.28 * gain, 800, 120);
        break;
      case "roundStart":
        tone("square", 480, 480, 0.08, 0.16 * gain);
        tone("square", 720, 720, 0.14, 0.18 * gain, 0.1);
        break;
      case "roundEnd":
        tone("triangle", 620, 620, 0.1, 0.18 * gain);
        tone("triangle", 780, 780, 0.16, 0.18 * gain, 0.09);
        break;
      case "matchOver":
        // A little fanfare. This is the moment somebody found out they're paying.
        tone("square", 523, 523, 0.12, 0.16 * gain);
        tone("square", 659, 659, 0.12, 0.16 * gain, 0.11);
        tone("square", 784, 784, 0.12, 0.16 * gain, 0.22);
        tone("square", 1047, 1047, 0.3, 0.18 * gain, 0.33);
        break;
    }
  }

  function play(name: SoundName, options: PlayOptions = {}): void {
    if (!ctx || !master || muted) return;
    if (ctx.state === "suspended") void ctx.resume();

    const gain = options.gain ?? 1;
    const rate = options.rate ?? 1;

    const sample = samples.get(name);
    if (sample) {
      const source = ctx.createBufferSource();
      source.buffer = sample;
      source.playbackRate.value = rate;
      const level = ctx.createGain();
      level.gain.value = gain;
      source.connect(level).connect(master);
      source.start();
      return;
    }

    synth(name, gain, rate);
  }

  return {
    unlock,
    play,
    get muted() {
      return muted;
    },
    toggleMute(): boolean {
      muted = !muted;
      if (master && ctx) {
        // Ramp rather than jump, so unmuting mid-fight doesn't click.
        master.gain.linearRampToValueAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime + 0.05);
      }
      try {
        localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
      } catch {
        // Private mode: the choice just won't survive a reload.
      }
      return muted;
    },
  };
}

export type Audio = ReturnType<typeof createAudio>;
