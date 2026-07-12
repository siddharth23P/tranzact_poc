'use strict';

// HTML escaping for ALL user-supplied data in rendered templates. Every field
// coming from the snapshot passes through here before entering the HTML, so a
// document containing `<script>` / `"` / `'` etc. cannot break out of its text
// node or attribute context. This is the single choke point — templates must
// never interpolate raw user data.

const MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => MAP[c]);
}

module.exports = { escapeHtml };
