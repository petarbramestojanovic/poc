/*! Counts a page visit and its conversion for one campaign. No cookie, no id, no library. */
;(function (window) {
  'use strict'
  var document = window.document
  var FIELDS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'brame_1',
    'brame_2',
    'brame_3',
  ]

  try {
    var script =
      document.currentScript ||
      document.querySelector('script[data-campaign][src*="/pages/tag.js"]')
    var campaign = script && script.getAttribute('data-campaign')
    if (!campaign) return
    var language = script.getAttribute('data-language') || ''
    var endpoint = new window.URL('event', script.src).href
    var brame = (window.brame = window.brame || {})
    var tags = (brame.tags = brame.tags || {})
    if (tags[campaign]) return // the same tag twice on one page counts once
    var key = 'brame:' + campaign
  } catch {
    return
  }

  function send(event, values) {
    var body = {
      campaign_id: campaign,
      event: event,
      language: language,
      referrer: values.referrer,
    }
    for (var i = 0; i < FIELDS.length; i++) body[FIELDS[i]] = values[FIELDS[i]]
    var data = JSON.stringify(body)
    try {
      // A string goes as text/plain: no CORS preflight, and it survives the page closing.
      if (window.navigator.sendBeacon && window.navigator.sendBeacon(endpoint, data)) return
    } catch {
      // fall through to fetch
    }
    try {
      window
        .fetch(endpoint, {
          method: 'POST',
          body: data,
          keepalive: true,
          mode: 'no-cors',
          credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' },
        })
        .catch(function () {})
    } catch {
      // nothing to do: the page must never notice
    }
  }

  /** This page's values: the URL parameters and the referrer, '' for each one missing. */
  function current() {
    var params = new window.URLSearchParams(window.location.search)
    var values = { referrer: document.referrer || '' }
    var tagged = false
    for (var i = 0; i < FIELDS.length; i++) {
      values[FIELDS[i]] = params.get(FIELDS[i]) || ''
      if (values[FIELDS[i]]) tagged = true
    }
    return { values: values, tagged: tagged }
  }

  function kept() {
    try {
      var stored = window.sessionStorage.getItem(key)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  }

  function keep(values) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(values))
    } catch {
      // storage blocked: a conversion then uses the page it happens on
    }
  }

  function visit() {
    var page = current()
    // The tab remembers how the visitor arrived: the landing page, or a newer click with parameters.
    if (page.tagged || !kept()) keep(page.values)
    send('visit', page.values)
  }

  tags[campaign] = function conversion() {
    send('conversion', kept() || current().values)
  }

  /** brame.conversion() reports one for every campaign on the page; with an id, for that one. */
  brame.conversion = function (id) {
    for (var name in tags) {
      if (Object.prototype.hasOwnProperty.call(tags, name) && (!id || id === name)) {
        try {
          tags[name]()
        } catch {
          // never into the page
        }
      }
    }
  }

  try {
    if (document.prerendering) {
      document.addEventListener('prerenderingchange', visit, { once: true })
    } else {
      visit()
    }
  } catch {
    // never into the page
  }
})(window)
