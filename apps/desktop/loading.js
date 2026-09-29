function update(status) {
  if (!status) return;
  document.getElementById('title').textContent = status.title;
  document.getElementById('detail').textContent = status.detail;
  document.getElementById('progress').hidden = status.failed;
}
window.startup.current().then(update);
window.startup.onStatus(update);
document.getElementById('logs').addEventListener('click', () => window.startup.openLogs());
