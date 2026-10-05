const API_BASE = '';

export async function getServers() {
  const res = await fetch(`${API_BASE}/api/servers`);
  if (!res.ok) throw new Error(`Failed to fetch servers: ${res.statusText}`);
  return res.json();
}

export async function getLibraries() {
  const res = await fetch(`${API_BASE}/api/libraries`);
  if (!res.ok) throw new Error(`Failed to fetch libraries: ${res.statusText}`);
  return res.json();
}

// --- Server health / picker ---

export async function getServerStatus() {
  const res = await fetch(`${API_BASE}/api/status`);
  if (!res.ok) throw new Error(`Failed to fetch server status: ${res.statusText}`);
  return res.json();
}

export async function getServerBackoff() {
  const res = await fetch(`${API_BASE}/api/servers/backoff`);
  if (!res.ok) throw new Error(`Failed to fetch backoff state: ${res.statusText}`);
  return res.json();
}

export async function recheckServers() {
  const res = await fetch(`${API_BASE}/api/status/check`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to recheck servers: ${res.statusText}`);
  return res.json();
}

export async function getLibraryItems(serverKey, libraryKey, { refresh = false } = {}) {
  const params = refresh ? '?refresh=true' : '';
  const res = await fetch(`${API_BASE}/api/library/${serverKey}/${libraryKey}${params}`);
  if (!res.ok) throw new Error(`Failed to fetch library items: ${res.statusText}`);
  return res.json();
}

export async function clearCache(serverKey, libraryKey) {
  const res = await fetch(`${API_BASE}/api/cache/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serverKey && libraryKey ? { serverKey, libraryKey } : {}),
  });
  if (!res.ok) throw new Error(`Failed to clear cache: ${res.statusText}`);
  return res.json();
}

export async function saveSettings(settings) {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`Failed to save settings: ${res.statusText}`);
  return res.json();
}

export async function getSettings() {
  const res = await fetch(`${API_BASE}/api/settings`);
  if (!res.ok) throw new Error(`Failed to fetch settings: ${res.statusText}`);
  return res.json();
}

export async function getSimilar(tmdbId, type) {
  const res = await fetch(`${API_BASE}/api/similar/${tmdbId}?type=${type}`);
  if (!res.ok) throw new Error(`Failed to fetch similar: ${res.statusText}`);
  return res.json();
}

export async function getStatus() {
  const res = await fetch(`${API_BASE}/api/status`);
  if (!res.ok) throw new Error(`Failed to fetch status: ${res.statusText}`);
  return res.json();
}

export async function checkStatus() {
  const res = await fetch(`${API_BASE}/api/status/check`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to check status: ${res.statusText}`);
  return res.json();
}

export async function getNewAdditions(days = 7) {
  const res = await fetch(`${API_BASE}/api/new-additions?days=${days}`);
  if (!res.ok) throw new Error(`Failed to fetch new additions: ${res.statusText}`);
  return res.json();
}

export async function getMatchingNewAdditions(criteriaId, days = 7) {
  const res = await fetch(`${API_BASE}/api/new-additions/matching?criteriaId=${criteriaId}&days=${days}`);
  if (!res.ok) throw new Error(`Failed to fetch matching additions: ${res.statusText}`);
  return res.json();
}

export async function saveCriteria(name, criteria) {
  const res = await fetch(`${API_BASE}/api/criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, criteria }),
  });
  if (!res.ok) throw new Error(`Failed to save criteria: ${res.statusText}`);
  return res.json();
}

export async function getCriteria() {
  const res = await fetch(`${API_BASE}/api/criteria`);
  if (!res.ok) throw new Error(`Failed to fetch criteria: ${res.statusText}`);
  return res.json();
}

export async function deleteCriteria(id) {
  const res = await fetch(`${API_BASE}/api/criteria/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete criteria: ${res.statusText}`);
  return res.json();
}

export async function getActors(serverKey, libraryKey) {
  const res = await fetch(`${API_BASE}/api/actors?serverKey=${serverKey}&libraryKey=${libraryKey}`);
  if (!res.ok) throw new Error(`Failed to fetch actors: ${res.statusText}`);
  return res.json();
}

export async function getDirectors(serverKey, libraryKey) {
  const res = await fetch(`${API_BASE}/api/directors?serverKey=${serverKey}&libraryKey=${libraryKey}`);
  if (!res.ok) throw new Error(`Failed to fetch directors: ${res.statusText}`);
  return res.json();
}

// --- Watchlist ---

export async function addToWatchlist(item) {
  const res = await fetch(`${API_BASE}/api/watchlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error(`Failed to add to watchlist: ${res.statusText}`);
  return res.json();
}

export async function removeFromWatchlist(id) {
  const res = await fetch(`${API_BASE}/api/watchlist/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to remove from watchlist: ${res.statusText}`);
  return res.json();
}

export async function getWatchlist(filter) {
  const params = filter ? `?filter=${filter}` : '';
  const res = await fetch(`${API_BASE}/api/watchlist${params}`);
  if (!res.ok) throw new Error(`Failed to fetch watchlist: ${res.statusText}`);
  return res.json();
}

export async function markWatched(id) {
  const res = await fetch(`${API_BASE}/api/watchlist/${id}/watched`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to mark as watched: ${res.statusText}`);
  return res.json();
}

export async function checkWatchlist(plexKey) {
  const res = await fetch(`${API_BASE}/api/watchlist/check/${plexKey}`);
  if (!res.ok) throw new Error(`Failed to check watchlist: ${res.statusText}`);
  return res.json();
}

// --- Trending ---

export async function getTrending(type, window) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (window) params.set('window', window);
  const res = await fetch(`${API_BASE}/api/trending?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch trending: ${res.statusText}`);
  return res.json();
}

// --- Stats ---

export async function getStats(serverKey, libraryKey) {
  const res = await fetch(`${API_BASE}/api/stats/${serverKey}/${libraryKey}`);
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.statusText}`);
  return res.json();
}

// --- Duplicates ---

export async function getDuplicates() {
  const res = await fetch(`${API_BASE}/api/duplicates`);
  if (!res.ok) throw new Error(`Failed to fetch duplicates: ${res.statusText}`);
  return res.json();
}

// --- Random Pick ---

export async function getRandomPick(serverKey, libraryKey, filters) {
  const params = new URLSearchParams();
  if (filters) {
    Object.entries(filters).forEach(([key, val]) => {
      if (val != null && val !== '' && val !== false) {
        params.set(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
      }
    });
  }
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/random/${serverKey}/${libraryKey}${qs}`);
  if (!res.ok) throw new Error(`Failed to get random pick: ${res.statusText}`);
  return res.json();
}

// --- Downloads ---

export async function getDownloadUrl(serverKey, ratingKey) {
  const res = await fetch(`${API_BASE}/api/download-url/${serverKey}/${ratingKey}`);
  if (!res.ok) {
    // The server says why in plain words (for example, the owner of a shared
    // server has not allowed downloads); pass that on instead of a status code.
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to get download URL: ${res.statusText}`);
  }
  return res.json();
}

export async function sendToGopeed(url, filename) {
  const res = await fetch(`${API_BASE}/api/download/gopeed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, filename }),
  });
  if (!res.ok) throw new Error(`Failed to send to Gopeed: ${res.statusText}`);
  return res.json();
}

// --- Plex Watchlist (Cloud Sync) ---

export async function addToPlexWatchlist(guid) {
  const res = await fetch(`${API_BASE}/api/plex-watchlist/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guid }),
  });
  if (!res.ok) throw new Error(`Failed to add to Plex watchlist: ${res.statusText}`);
  return res.json();
}

export async function removeFromPlexWatchlist(guid) {
  const res = await fetch(`${API_BASE}/api/plex-watchlist/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guid }),
  });
  if (!res.ok) throw new Error(`Failed to remove from Plex watchlist: ${res.statusText}`);
  return res.json();
}

export async function getPlexWatchlist() {
  const res = await fetch(`${API_BASE}/api/plex-watchlist`);
  if (!res.ok) throw new Error(`Failed to fetch Plex watchlist: ${res.statusText}`);
  return res.json();
}

// --- Watch Later Queue ---

export async function addToQueue(item) {
  const res = await fetch(`${API_BASE}/api/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error(`Failed to add to queue: ${res.statusText}`);
  return res.json();
}

export async function removeFromQueue(id) {
  const res = await fetch(`${API_BASE}/api/queue/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to remove from queue: ${res.statusText}`);
  return res.json();
}

export async function getQueueItems() {
  const res = await fetch(`${API_BASE}/api/queue`);
  if (!res.ok) throw new Error(`Failed to fetch queue: ${res.statusText}`);
  return res.json();
}

export async function reorderQueue(id, position) {
  const res = await fetch(`${API_BASE}/api/queue/${id}/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position }),
  });
  if (!res.ok) throw new Error(`Failed to reorder queue: ${res.statusText}`);
  return res.json();
}

export async function checkQueue(plexKey) {
  const res = await fetch(`${API_BASE}/api/queue/check/${plexKey}`);
  if (!res.ok) throw new Error(`Failed to check queue: ${res.statusText}`);
  return res.json();
}

// --- Personal Ratings ---

// A rating key is only unique inside one Plex server, so a call about one
// title says which server it is on. The title and year go along so a thumb or
// a hidden title saved before servers were stored can still be recognized.
function titleQuery({ serverKey, title, year } = {}) {
  const params = new URLSearchParams();
  if (serverKey) params.set('serverKey', serverKey);
  if (title) params.set('title', title);
  if (year) params.set('year', String(year));
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** `item` includes serverKey, the Plex server the title is on. */
export async function rateItemPersonal(item) {
  const res = await fetch(`${API_BASE}/api/ratings/personal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error(`Failed to rate item: ${res.statusText}`);
  return res.json();
}

/** `item` is { serverKey, title, year } for the title being un-rated. */
export async function removePersonalRating(plexKey, item) {
  const res = await fetch(`${API_BASE}/api/ratings/personal/${plexKey}${titleQuery(item)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to remove rating: ${res.statusText}`);
  return res.json();
}

/** `item` is { serverKey, title, year } for the title being looked up. */
export async function getPersonalRating(plexKey, item) {
  const res = await fetch(`${API_BASE}/api/ratings/personal/${plexKey}${titleQuery(item)}`);
  if (!res.ok) throw new Error(`Failed to fetch rating: ${res.statusText}`);
  return res.json();
}

export async function getAllPersonalRatings(filter) {
  const params = filter && filter !== 'all' ? `?filter=${filter}` : '';
  const res = await fetch(`${API_BASE}/api/ratings/personal${params}`);
  if (!res.ok) throw new Error(`Failed to fetch ratings: ${res.statusText}`);
  return res.json();
}

export async function getPersonalInsights() {
  const res = await fetch(`${API_BASE}/api/ratings/personal/insights`);
  if (!res.ok) throw new Error(`Failed to fetch insights: ${res.statusText}`);
  return res.json();
}

// --- Subscriptions & Alerts ---

export async function subscribeToShow(item) {
  const res = await fetch(`${API_BASE}/api/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error(`Failed to subscribe: ${res.statusText}`);
  return res.json();
}

export async function unsubscribeFromShow(id) {
  const res = await fetch(`${API_BASE}/api/subscriptions/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to unsubscribe: ${res.statusText}`);
  return res.json();
}

export async function getSubscriptions() {
  const res = await fetch(`${API_BASE}/api/subscriptions`);
  if (!res.ok) throw new Error(`Failed to fetch subscriptions: ${res.statusText}`);
  return res.json();
}

export async function checkSubscription(plexKey) {
  const res = await fetch(`${API_BASE}/api/subscriptions/check/${plexKey}`);
  if (!res.ok) throw new Error(`Failed to check subscription: ${res.statusText}`);
  return res.json();
}

export async function triggerEpisodeCheck() {
  const res = await fetch(`${API_BASE}/api/subscriptions/check-episodes`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to check episodes: ${res.statusText}`);
  return res.json();
}

export async function getUnseenAlerts() {
  const res = await fetch(`${API_BASE}/api/subscriptions/alerts`);
  if (!res.ok) throw new Error(`Failed to fetch alerts: ${res.statusText}`);
  return res.json();
}

export async function getSubscriptionAlerts(subscriptionId) {
  const res = await fetch(`${API_BASE}/api/subscriptions/${subscriptionId}/alerts`);
  if (!res.ok) throw new Error(`Failed to fetch subscription alerts: ${res.statusText}`);
  return res.json();
}

export async function markAlertAsSeen(alertId) {
  const res = await fetch(`${API_BASE}/api/subscriptions/alerts/${alertId}/seen`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to mark alert seen: ${res.statusText}`);
  return res.json();
}

export async function markAllSubscriptionAlertsSeen(subscriptionId) {
  const res = await fetch(`${API_BASE}/api/subscriptions/${subscriptionId}/alerts/seen-all`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to mark all alerts seen: ${res.statusText}`);
  return res.json();
}

export async function getUnseenAlertCount() {
  const res = await fetch(`${API_BASE}/api/subscriptions/alerts/count`);
  if (!res.ok) throw new Error(`Failed to fetch alert count: ${res.statusText}`);
  return res.json();
}

// --- Trailers ---

export async function getTrailer(tmdbId, type) {
  const params = type ? `?type=${type}` : '';
  const res = await fetch(`${API_BASE}/api/trailers/${tmdbId}${params}`);
  if (!res.ok) throw new Error(`Failed to fetch trailer: ${res.statusText}`);
  return res.json();
}

// --- Moods / Tonight Mode ---

export async function getMoods() {
  const res = await fetch(`${API_BASE}/api/moods`);
  if (!res.ok) throw new Error(`Failed to fetch moods: ${res.statusText}`);
  return res.json();
}

export async function getTonightPicks(serverKey, libraryKey, mood, count = 5) {
  const params = new URLSearchParams({ serverKey, libraryKey, mood, count: String(count) });
  const res = await fetch(`${API_BASE}/api/tonight?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch tonight picks: ${res.statusText}`);
  return res.json();
}

// --- Not Interested feedback ---

/** `item` includes serverKey, the Plex server the title is on. */
export async function markNotInterested(item) {
  const res = await fetch(`${API_BASE}/api/feedback/not-interested`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error(`Failed to mark not interested: ${res.statusText}`);
  return res.json();
}

/** `item` is { serverKey, title, year } for the title being un-hidden. */
export async function unmarkNotInterested(plexKey, item) {
  const res = await fetch(`${API_BASE}/api/feedback/not-interested/${encodeURIComponent(plexKey)}${titleQuery(item)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to unmark not interested: ${res.statusText}`);
  return res.json();
}

export async function listNotInterested() {
  const res = await fetch(`${API_BASE}/api/feedback/not-interested`);
  if (!res.ok) throw new Error(`Failed to list not interested: ${res.statusText}`);
  return res.json();
}

// --- Curated Views ---

export async function createCuratedView(payload) {
  const res = await fetch(`${API_BASE}/api/views`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // The server says what was wrong with the view (an edit PIN that is too short, for one).
    const problem = await res.json().catch(() => null);
    throw new Error(problem?.error || `Failed to create view: ${res.statusText}`);
  }
  return res.json();
}

export async function listCuratedViews() {
  const res = await fetch(`${API_BASE}/api/views`);
  if (!res.ok) throw new Error(`Failed to list views: ${res.statusText}`);
  return res.json();
}

export async function getCuratedView(slug) {
  const res = await fetch(`${API_BASE}/api/views/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Failed to fetch view: ${res.statusText}`);
  return res.json();
}

export async function getCuratedViewItems(slug) {
  const res = await fetch(`${API_BASE}/api/views/${encodeURIComponent(slug)}/items`);
  if (!res.ok) throw new Error(`Failed to fetch view items: ${res.statusText}`);
  return res.json();
}

export async function updateCuratedView(slug, payload) {
  const res = await fetch(`${API_BASE}/api/views/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to update view: ${res.statusText}`);
  return res.json();
}

export async function deleteCuratedView(slug, editPin) {
  // The edit PIN goes in the body. In the address it would be kept in logs
  // and history, and the server refuses it there.
  const res = await fetch(`${API_BASE}/api/views/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(editPin ? { editPin } : {}),
  });
  if (!res.ok) throw new Error(`Failed to delete view: ${res.statusText}`);
  return res.json();
}

// --- Discovery rows ---

export async function getBecauseYouLikedRows(serverKey, libraryKey, count = 3) {
  const params = new URLSearchParams({ serverKey, libraryKey, count: String(count) });
  const res = await fetch(`${API_BASE}/api/discovery/because-you-liked-rows?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch because-you-liked rows: ${res.statusText}`);
  return res.json();
}

export async function getBecauseYouLiked(serverKey, libraryKey, seedKey, count = 12) {
  const params = new URLSearchParams({ serverKey, libraryKey, seedKey, count: String(count) });
  const res = await fetch(`${API_BASE}/api/discovery/because-you-liked?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch because-you-liked: ${res.statusText}`);
  return res.json();
}

export async function getHiddenGems(serverKey, libraryKey, count = 20) {
  const params = new URLSearchParams({ serverKey, libraryKey, count: String(count) });
  const res = await fetch(`${API_BASE}/api/discovery/hidden-gems?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch hidden gems: ${res.statusText}`);
  return res.json();
}

export async function getRecentlyAddedDiscovery(serverKey, libraryKey, days = 30, count = 20) {
  const params = new URLSearchParams({ serverKey, libraryKey, days: String(days), count: String(count) });
  const res = await fetch(`${API_BASE}/api/discovery/recently-added?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch recently added: ${res.statusText}`);
  return res.json();
}

export async function getPercentMatch(serverKey, libraryKey, plexKey) {
  const params = new URLSearchParams({ serverKey, libraryKey });
  const res = await fetch(`${API_BASE}/api/discovery/percent-match/${encodeURIComponent(plexKey)}?${params.toString()}`);
  if (!res.ok) return { percent: null };
  return res.json();
}

// --- Plex Sessions / Clients / Remote Play ---

export async function getPlexSessions() {
  const res = await fetch(`${API_BASE}/api/plex/sessions`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.statusText}`);
  return res.json();
}

export async function getPlexClients() {
  const res = await fetch(`${API_BASE}/api/plex/clients`);
  if (!res.ok) throw new Error(`Failed to fetch clients: ${res.statusText}`);
  return res.json();
}

export async function playOnDevice({ serverKey, clientMachineIdentifier, ratingKey, offset = 0 }) {
  const res = await fetch(`${API_BASE}/api/plex/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverKey, clientMachineIdentifier, ratingKey, offset }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to start playback: ${res.statusText}`);
  }
  return res.json();
}

// --- Voice ---

export async function parseVoice(transcript) {
  const res = await fetch(`${API_BASE}/api/voice/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
  });
  if (!res.ok) throw new Error(`Failed to parse voice: ${res.statusText}`);
  return res.json();
}

// --- Wrapped ---

export async function getWrapped(serverKey, libraryKey, days = 90) {
  const params = new URLSearchParams({ serverKey, libraryKey, days: String(days) });
  const res = await fetch(`${API_BASE}/api/wrapped?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch wrapped: ${res.statusText}`);
  return res.json();
}

// --- External Lists (MDBList / TMDB / Letterboxd / Trakt) ---

export async function getListSources() {
  const res = await fetch(`${API_BASE}/api/lists/sources`);
  if (!res.ok) throw new Error(`Failed to fetch list sources: ${res.statusText}`);
  return res.json();
}

export async function getFeaturedLists() {
  const res = await fetch(`${API_BASE}/api/lists/featured`);
  if (!res.ok) throw new Error(`Failed to fetch featured lists: ${res.statusText}`);
  return res.json();
}

export async function getProviderLists(provider) {
  const res = await fetch(`${API_BASE}/api/lists/${encodeURIComponent(provider)}`);
  if (!res.ok) throw new Error(`Failed to fetch ${provider} lists: ${res.statusText}`);
  return res.json();
}

export async function getListItems(provider, listId, { serverKey, libraryKey, matchAll = false } = {}) {
  const params = new URLSearchParams({ listId });
  if (serverKey) params.set('serverKey', serverKey);
  if (libraryKey) params.set('libraryKey', libraryKey);
  if (matchAll) params.set('matchAll', 'true');
  const res = await fetch(`${API_BASE}/api/lists/${encodeURIComponent(provider)}/items?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch list items: ${res.statusText}`);
  return res.json();
}

// --- Streaming availability (Netflix and friends) ---

export async function getProviders() {
  const res = await fetch(`${API_BASE}/api/providers`);
  if (!res.ok) throw new Error(`Failed to fetch providers: ${res.statusText}`);
  return res.json();
}

export async function getAvailability(type, tmdbId, region = 'US') {
  const params = new URLSearchParams({ region });
  const res = await fetch(`${API_BASE}/api/availability/${type}/${tmdbId}?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch availability: ${res.statusText}`);
  return res.json();
}

export async function getAvailabilityBatch(items, region = 'US') {
  const res = await fetch(`${API_BASE}/api/availability/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, region }),
  });
  if (!res.ok) throw new Error(`Failed to fetch availability: ${res.statusText}`);
  return res.json();
}

export async function getStreamingCatalog(provider, options = {}) {
  const params = new URLSearchParams();
  Object.entries(options).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  });
  const res = await fetch(`${API_BASE}/api/streaming/${encodeURIComponent(provider)}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to browse ${provider}: ${res.statusText}`);
  }
  return res.json();
}

// --- Cast to TV (DLNA, no Plex app needed on the TV) ---

export async function getTvDevices() {
  const res = await fetch(`${API_BASE}/api/tv/devices`);
  if (!res.ok) throw new Error(`Failed to find TVs: ${res.statusText}`);
  return res.json();
}

export async function playOnTv({ serverKey, ratingKey, controlUrl }) {
  const res = await fetch(`${API_BASE}/api/tv/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverKey, ratingKey, controlUrl }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Failed to start playback: ${res.statusText}`);
    // The owner has not approved this TV for other devices: the picker says so
    // beside that TV and leaves the rest of the list usable.
    err.tvNotApproved = Boolean(body.tvNotApproved);
    throw err;
  }
  return body;
}

export async function controlTv(controlUrl, action) {
  const res = await fetch(`${API_BASE}/api/tv/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ controlUrl, action }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed to ${action}: ${res.statusText}`);
  return body;
}

export async function matchAgainstLibraries(items) {
  const res = await fetch(`${API_BASE}/api/library-match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`Failed to match libraries: ${res.statusText}`);
  return res.json();
}

// --- Viewer profiles ---

export async function getProfiles() {
  const res = await fetch(`${API_BASE}/api/profiles`);
  if (!res.ok) throw new Error(`Failed to fetch profiles: ${res.statusText}`);
  return res.json();
}

export async function createProfile(name, emoji, color) {
  const res = await fetch(`${API_BASE}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, emoji, color }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed to create profile: ${res.statusText}`);
  return body;
}

export async function getShelves(options = {}) {
  const params = new URLSearchParams();
  if (options.count) params.set('count', String(options.count));
  if (options.moods) params.set('moods', options.moods);
  const res = await fetch(`${API_BASE}/api/shelves?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch shelves: ${res.statusText}`);
  return res.json();
}

export async function askForSomething(question) {
  const res = await fetch(`${API_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed to ask: ${res.statusText}`);
  return body;
}

// --- Couples swipe ---

// Each phone gets its own id for swiping. Votes used to be filed under the
// profile, and two phones that never picked one both voted as profile 1, so
// the second person's votes replaced the first and no match could ever form.
function swipeDeviceId() {
  const KEY = 'heldover.swipeDevice';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9-]/g, '');
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // No storage (private window): a per-visit id still works for one round.
    if (!swipeDeviceId.fallback) swipeDeviceId.fallback = `visit-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    return swipeDeviceId.fallback;
  }
}

export async function createSwipeSession({ size = 40, mood, previousCode } = {}) {
  const res = await fetch(`${API_BASE}/api/swipe/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size, mood, previousCode }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed to start: ${res.statusText}`);
  return body;
}

export async function getSwipeSession(code) {
  const res = await fetch(
    `${API_BASE}/api/swipe/session/${encodeURIComponent(code)}?voter=${encodeURIComponent(swipeDeviceId())}`
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed to join: ${res.statusText}`);
  return body;
}

export async function sendSwipeVote({ code, cardKey, vote }) {
  const res = await fetch(`${API_BASE}/api/swipe/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, cardKey, vote, voter: swipeDeviceId() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Vote failed: ${res.statusText}`);
  return body;
}
