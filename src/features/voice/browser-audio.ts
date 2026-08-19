const SILENT_AUDIO_DATA_URL = "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/** 在用户点击手势里预播放极短静音，解锁后续异步生成的语音。 */
export function unlockAudioElement(audio: HTMLAudioElement): void {
  audio.muted = true;
  audio.src = SILENT_AUDIO_DATA_URL;
  void audio.play().then(() => {
    if (audio.src !== SILENT_AUDIO_DATA_URL) return;
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute("src");
    audio.muted = false;
  }).catch(() => {
    if (audio.src !== SILENT_AUDIO_DATA_URL) return;
    audio.removeAttribute("src");
    audio.muted = false;
  });
}
