(async function () {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;

  try {
    const faces = await fonts.load('24px "Material Symbols Outlined"', 'person');
    if (faces.length && faces.every(face => face.status === 'loaded')) {
      document.documentElement.classList.add('vaultsso-icons-ready');
    }
  } catch {
    // Keep the icon slots blank if the separately supplied font is unavailable.
  }
}());
