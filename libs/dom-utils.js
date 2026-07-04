function $(selector, root = document) {
  return root.querySelector(selector)
}

function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector))
}

function createElement(tag, options = {}) {
  const el = document.createElement(tag)
  if (options.className) el.className = options.className
  if (options.text) el.textContent = options.text
  if (options.html) el.innerHTML = options.html
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([key, value]) => el.setAttribute(key, String(value)))
  }
  if (options.events) {
    Object.entries(options.events).forEach(([name, handler]) => el.addEventListener(name, handler))
  }
  return el
}

function escapeHtml(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function formatCount(value) {
  const n = Number(value)
  if (!n) return '0'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

function formatDate(iso) {
  if (!iso) return '--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function on(el, event, handler) {
  if (!el) return
  el.addEventListener(event, handler)
}

module.exports = {
  $, $all, createElement, escapeHtml, formatCount, formatDate, on,
}
