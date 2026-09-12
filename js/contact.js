// Copy only the visible address or outline. No account, recording or log data is read.
const status = document.getElementById('contactCopyStatus');
document.querySelectorAll('[data-copy-target]').forEach(button => {
  const target = document.getElementById(button.dataset.copyTarget);
  if (!target) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      await navigator.clipboard.writeText(target.value ?? target.textContent.trim());
      status.textContent = button.dataset.copySuccess;
    } catch {
      status.textContent = 'Copy is unavailable in this browser. Select the address or outline and copy it manually.';
      if (target.select) { target.focus(); target.select(); }
    } finally { button.disabled = false; }
  });
});
