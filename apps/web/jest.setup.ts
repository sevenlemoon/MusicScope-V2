import "@testing-library/jest-dom";

class TestAudio extends EventTarget {
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 180;
  paused = true;
  load() { this.dispatchEvent(new Event("loadedmetadata")); }
  async play() { this.paused = false; this.dispatchEvent(new Event("playing")); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  removeAttribute() { this.src = ""; }
}

global.Audio = TestAudio as unknown as typeof Audio;
