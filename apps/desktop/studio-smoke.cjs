// These functions are serialized into the sandboxed renderer. Keep them self-contained.
function studioReady(document, hasJob) {
  if (!hasJob) return Boolean(document.querySelector('.studio-page input[type="file"]'));
  const mixer = document.querySelector('[data-studio-mixer]');
  return Boolean(mixer && mixer.querySelectorAll('[data-stem]').length === 6 &&
    mixer.querySelectorAll('[data-studio-export]').length === 6 &&
    mixer.querySelector('[data-studio-play]') && mixer.querySelector('[data-studio-position]'));
}

async function playbackAcceptance(document) {
  const play = document.querySelector('[data-studio-play]');
  const position = document.querySelector('[data-studio-position]');
  if (!play || !position || document.querySelectorAll('[data-studio-export]').length !== 6) {
    throw Error('Missing mixer controls');
  }
  play.click();
  await new Promise(resolve => setTimeout(resolve, 1500));
  if (!(Number(position.value) > 0.1) || play.getAttribute('aria-pressed') !== 'true') {
    throw Error('Playback did not advance');
  }
  await new Promise(resolve => setTimeout(resolve, 4000));
  if (play.getAttribute('aria-pressed') !== 'false') throw Error('Playback did not finish');
  return { status: 'passed', six_stem_controls: true, playback_advanced: true,
    ended_state: true, export_links: 6, speaker_listening_test: false };
}

module.exports = { studioReady, playbackAcceptance };
