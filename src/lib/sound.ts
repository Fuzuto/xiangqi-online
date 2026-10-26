export type SoundName =
  'move' | 'capture' | 'turn' | 'check' | 'win' | 'lose' | 'draw' | 'low' | 'join' | 'disconnect';
let context: AudioContext | null = null;
export async function unlockSound() {
  context ??= new AudioContext();
  await context.resume();
  return context.state === 'running';
}
export function playSound(name: SoundName, volume: number) {
  if (!context || context.state !== 'running' || volume <= 0) return;
  const frequencies: Record<SoundName, number[]> = {
    move: [360],
    capture: [240, 180],
    turn: [520, 660],
    check: [660, 520, 660],
    win: [440, 554, 660],
    lose: [330, 260, 220],
    draw: [440, 440],
    low: [880, 880],
    join: [440, 660],
    disconnect: [440, 330],
  };
  frequencies[name].forEach((frequency, index) => {
    const oscillator = context!.createOscillator();
    const gain = context!.createGain();
    const start = context!.currentTime + index * 0.12;
    oscillator.type = name === 'capture' ? 'triangle' : 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume * 0.15, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.11);
    oscillator.connect(gain);
    gain.connect(context!.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.12);
  });
}
