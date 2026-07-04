function pickFirstString(values) {
  return values.find(v => typeof v === 'string' && v.trim()) || null
}

function normalizeFriendIdentity(friend = {}, userDetails = {}) {
  const id = friend?.id ?? userDetails?.id ?? null
  const username = pickFirstString([
    friend?.username,
    friend?.userName,
    friend?.name,
    userDetails?.username,
    userDetails?.name,
    userDetails?.userName,
  ])

  const displayName = pickFirstString([
    friend?.displayName,
    friend?.display_name,
    friend?.name,
    friend?.username,
    friend?.userName,
    userDetails?.displayName,
    userDetails?.display_name,
    userDetails?.name,
    userDetails?.username,
    userDetails?.userName,
  ])

  const fallbackName = id != null ? `User${id}` : 'User'
  return {
    username: username || fallbackName,
    displayName: displayName || username || fallbackName,
  }
}

module.exports = {
  normalizeFriendIdentity,
}
