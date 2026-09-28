const params = new URLSearchParams(window.location.search);
  const error = params.get('error') || 'invalid_request';
  const description = params.get('error_description') || 'The authorization request could not be completed.';
  document.getElementById('errorTitle').textContent = error;
  document.getElementById('errorDescription').textContent = description;
  document.getElementById('errorCode').textContent = error;
  document.getElementById('stateValue').textContent = params.get('state') || 'N/A';
  document.getElementById('clientValue').textContent = params.get('client_id') || 'N/A';
  document.getElementById('timeValue').textContent = new Date().toISOString();
  document.getElementById('tryAgainBtn').addEventListener('click', function () {
    this.disabled = true;
    this.innerHTML = '<span class="material-symbols-outlined animate-spin align-middle mr-2">progress_activity</span>Returning...';
    window.location.href = '/oauth2/authorize';
  });
