async function playThemeTransition(applyFn, label) {
  const overlay = document.getElementById('theme-transition')
  if (!overlay) {
    await applyFn()
    return
  }

  const labelEl = overlay.querySelector('.tt-label')
  if (labelEl) labelEl.textContent = label || 'Applying theme...'

  overlay.classList.remove('reveal')
  overlay.classList.add('show')
  await new Promise(resolve => setTimeout(resolve, 320))

  try {
    await applyFn()
  } finally {
    await new Promise(resolve => setTimeout(resolve, 180))
    overlay.classList.add('reveal')
    setTimeout(() => overlay.classList.remove('show', 'reveal'), 550)
  }
}

module.exports = {
  playThemeTransition,
}
